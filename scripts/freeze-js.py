"""Record the installed macOS layout produced by a frozen pnpm install. Maintainer tool."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "scripts/js-install-lock.json"


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def packages(directory):
    for entry in sorted(directory.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.name.startswith("@"):
            yield from sorted(entry.iterdir())
        else:
            yield entry


def capture(project):
    modules = project / "node_modules"
    store = modules / ".pnpm"
    lockfile = project / "pnpm-lock.yaml"
    lock = json.loads(subprocess.check_output([
        "/usr/bin/ruby", "-rpsych", "-rjson", "-e",
        "puts JSON.generate(Psych.safe_load(File.read(ARGV[0])))", str(lockfile)
    ]))
    if (store / "lock.yaml").read_bytes() != lockfile.read_bytes():
        raise ValueError("Install the exact frozen lock before recording " + str(project))
    slots = {}
    targets = {}
    for directory in sorted(store.iterdir()):
        if not directory.is_dir() or directory.name == "node_modules":
            continue
        own, = [entry for entry in packages(directory / "node_modules") if not entry.is_symlink()]
        pkg = json.loads((own / "package.json").read_bytes())
        name, version = pkg["name"], pkg["version"]
        resolution = lock["packages"][name + "@" + version]["resolution"]
        if set(resolution) != {"integrity"} or not resolution["integrity"].startswith("sha512-"):
            raise ValueError("Only integrity-pinned registry packages are supported")
        if len(base64.b64decode(resolution["integrity"][7:], validate=True)) != 64:
            raise ValueError("Invalid registry integrity")
        targets[own.resolve()] = directory.name
        slots[directory.name] = [name, version, resolution["integrity"]]

    def links(directory):
        return {str(entry.relative_to(directory)): targets[entry.resolve(strict=True)]
                for entry in packages(directory) if entry.is_symlink()}

    for slot, package in slots.items():
        package.append(links(store / slot / "node_modules"))
    direct = links(modules)
    manifest = json.loads((project / "package.json").read_bytes())
    if set(direct) != set(manifest["devDependencies"]):
        raise ValueError("Direct dependency set differs from the manifest")
    for name, version in manifest["devDependencies"].items():
        if slots[direct[name]][:2] != [name, version]:
            raise ValueError("Expected exact direct dependency: " + name)
    return {"packageSha256": digest(project / "package.json"), "lockSha256": digest(lockfile),
            "direct": direct, "hoist": links(store / "node_modules"), "packages": slots}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="replace the reviewed layout after a lock update")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("Regenerate on macOS arm64")
    receipt = {"format": 1, "platform": "darwin-arm64", "workspaceSha256": digest(ROOT / "pnpm-workspace.yaml"),
               "root": capture(ROOT), "desktop": capture(ROOT / "desktop")}
    data = json.dumps(receipt, indent=2, ensure_ascii=True) + "\n"
    if args.write:
        OUTPUT.write_text(data, encoding="utf-8")
        print("Set runtime-lock.json jsInstallSha256 to", digest(OUTPUT))
    elif OUTPUT.read_text(encoding="utf-8") != data:
        raise SystemExit("Reviewed installer layout differs from the frozen pnpm installation")
    elif json.loads((ROOT / "scripts/runtime-lock.json").read_bytes())["jsInstallSha256"] != digest(OUTPUT):
        raise SystemExit("Runtime lock differs from the reviewed installer layout")
    print("Verified frozen macOS layout for root and desktop")
