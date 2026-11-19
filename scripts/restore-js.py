"""Restore NoteTrail's reviewed macOS package layout without running a package manager."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
NAME = re.compile(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*\Z")
SLOT = re.compile(r"[@a-zA-Z0-9][@a-zA-Z0-9._+-]*\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?\Z")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def reviewed_layout(scope):
    require(platform.system() == "Darwin" and platform.machine() == "arm64", "Requires macOS arm64")
    receipt_file = ROOT / "scripts/js-install-lock.json"
    runtime = json.loads((ROOT / "scripts/runtime-lock.json").read_bytes())
    require(sha256(receipt_file) == runtime["jsInstallSha256"], "Invalid JS layout receipt")
    receipt = json.loads(receipt_file.read_bytes())
    project = ROOT if scope == "root" else ROOT / "desktop"
    layout = receipt[scope]
    require(receipt["format"] == 1 and receipt["platform"] == "darwin-arm64" and
            receipt["workspaceSha256"] == sha256(ROOT / "pnpm-workspace.yaml") and
            layout["packageSha256"] == sha256(project / "package.json") and
            layout["lockSha256"] == sha256(project / "pnpm-lock.yaml"), "Frozen JS inputs have changed")
    packages = layout["packages"]
    for slot, (name, version, integrity, deps) in packages.items():
        require(SLOT.fullmatch(slot) and NAME.fullmatch(name) and VERSION.fullmatch(version)
                and integrity.startswith("sha512-") and len(base64.b64decode(integrity[7:], validate=True)) == 64,
                "Invalid package in reviewed layout")
    for links in [layout["direct"], layout["hoist"], *(row[3] for row in packages.values())]:
        require(all(NAME.fullmatch(alias) and target in packages for alias, target in links.items()),
                "Invalid dependency link")
    return project, layout


def get_archive(cache, url, algorithm, expected, extension, redirects=False):
    file = cache / (expected.hex() + extension)

    def verified(p):
        st = p.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_nlink == 1 and
                st.st_size <= 268435456, "Unsafe package cache file")
        with p.open("rb") as stream:
            require(hashlib.file_digest(stream, algorithm).digest() == expected, "Package hash mismatch: " + url)

    if os.path.lexists(file):
        verified(file)
    else:
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as tmp:
            pending = Path(tmp.name)
        try:
            follow = ["--location", "--proto-redir", "=https"] if redirects else []
            subprocess.run(["/usr/bin/curl", "-q", "--proto", "=https", *follow, "--fail", "--silent", "--show-error",
                            "--retry", "2", "--retry-all-errors", "--speed-limit", "1", "--speed-time", "60",
                            "--connect-timeout", "15", "--max-time", "900", "--max-filesize",
                            "268435456", url, "-o", str(pending)], check=True, env={"PATH": "/usr/bin:/bin", "LANG": "C"})
            verified(pending)
            os.replace(pending, file)
        finally:
            pending.unlink(missing_ok=True)
    return file


def extract_package(archive, dest, name, version):
    dest.mkdir(parents=True)
    prefix = None
    total = 0
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            components = member.name.rstrip("/").split("/")
            parts = [components[0], *(p for p in components[1:] if p != ".")]
            require(all(p not in ("", ".", "..") and "\\" not in p for p in parts), "Invalid package member path")
            prefix = prefix or parts[0]
            require(parts[0] == prefix and (member.isdir() or member.isreg()), "Unsupported package member")
            if len(parts) == 1:
                require(member.isdir(), "Invalid package archive root")
                continue
            target = dest.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                total += member.size
                require(0 <= member.size and total <= 536870912, "Package expanded size exceeded")
                target.parent.mkdir(parents=True, exist_ok=True)
                mode = 0o755 if member.mode & 0o111 else 0o644
                with tar.extractfile(member) as source:
                    if target.exists():
                        # Some npm archives repeat a file under both dist/ and ./dist/.
                        require(target.is_file() and stat.S_IMODE(target.stat().st_mode) == mode and
                                sha256(target) == hashlib.file_digest(source, "sha256").hexdigest(),
                                "Conflicting duplicate package member")
                    else:
                        with target.open("xb") as output:
                            shutil.copyfileobj(source, output)
                        target.chmod(mode)
    manifest = json.loads((dest / "package.json").read_bytes())
    require(manifest["name"] == name and manifest["version"] == version, "Unexpected package identity")


def install_electron(package, cache, version):
    filename = "electron-v" + version + "-darwin-arm64.zip"
    expected = bytes.fromhex(json.loads((package / "checksums.json").read_bytes())[filename])
    require(len(expected) == 32, "Invalid Electron release checksum")
    url = "https://github.com/electron/electron/releases/download/v" + version + "/" + filename
    archive = get_archive(cache, url, "sha256", expected, ".zip", redirects=True)
    dist = package / "dist"
    dist.mkdir()
    subprocess.run(["/usr/bin/ditto", "-x", "-k", str(archive), str(dist)], check=True,
                   env={"PATH": "/usr/bin:/bin", "LANG": "C"})
    for item in dist.rglob("*"):
        if item.is_symlink():
            require(not os.path.isabs(os.readlink(item)) and item.resolve(strict=True).is_relative_to(dist),
                    "External Electron distribution link")
    binary = "Electron.app/Contents/MacOS/Electron"
    require((dist / binary).is_file() and (dist / "version").read_text().strip() == version, "Invalid Electron runtime")
    declarations = dist / "electron.d.ts"
    if declarations.exists():
        declarations.replace(package / "electron.d.ts")
    (package / "path.txt").write_text(binary)


def restore(scope, cache, output=None):
    project, layout = reviewed_layout(scope)
    if output is not None:
        require(scope == "desktop" and output.is_absolute() and output.resolve() == output and
                output.is_dir() and output.stat().st_uid == os.getuid() and
                stat.S_IMODE(output.stat().st_mode) == 0o700 and not any(output.iterdir()),
                "Desktop packaging requires an empty private staging directory")
        project = output
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(cache.is_absolute() and cache.resolve() == cache and cache.stat().st_uid == os.getuid()
            and not cache.stat().st_mode & 0o022, "Unsafe cache directory")
    modules = project / "node_modules"
    marker = ".notetrail-layout"
    stamp = layout["lockSha256"] + "\n" + sha256(ROOT / "scripts/js-install-lock.json") + "\n"
    if os.path.lexists(modules):
        require(modules.is_dir() and not modules.is_symlink() and (modules / marker).is_file()
                and not (modules / marker).is_symlink() and (modules / marker).read_text() == stamp,
                "Existing node_modules belongs to another installation; use a clean source copy")
    with tempfile.TemporaryDirectory(prefix=".notetrail-js-", dir=project) as staging:
        new = Path(staging) / "node_modules"
        store = new / ".pnpm"
        packages = layout["packages"]

        def install(item):
            slot, (name, version, integrity, _) = item
            dest = store / slot / "node_modules" / name
            url = "https://registry.npmjs.org/" + name + "/-/" + name.split("/")[-1] + "-" + version + ".tgz"
            archive = get_archive(cache, url, "sha512", base64.b64decode(integrity[7:]), ".tgz")
            extract_package(archive, dest, name, version)

        with ThreadPoolExecutor(max_workers=6) as pool:
            for _ in pool.map(install, packages.items()):
                pass

        def link_set(directory, links):
            for alias, slot in links.items():
                link = directory / alias
                link.parent.mkdir(parents=True, exist_ok=True)
                target = store / slot / "node_modules" / packages[slot][0]
                link.symlink_to(os.path.relpath(target, link.parent))

        for slot, row in packages.items():
            link_set(store / slot / "node_modules", row[3])
        link_set(store / "node_modules", layout["hoist"])
        link_set(new, layout["direct"])
        if scope == "desktop":
            slot = layout["direct"]["electron"]
            install_electron(store / slot / "node_modules/electron", cache, packages[slot][1])
        (new / marker).write_text(stamp)
        if modules.exists():
            require(modules.resolve() == modules and
                    {p.relative_to(modules) for p in modules.rglob("*")} ==
                    {p.relative_to(new) for p in new.rglob("*")},
                    "Existing dependency tree has extra or missing files; use a clean source copy")
            for entry in new.rglob("*"):
                installed = modules / entry.relative_to(new)
                if entry.is_symlink():
                    ok = installed.is_symlink() and os.readlink(installed) == os.readlink(entry)
                elif entry.is_dir():
                    ok = installed.is_dir() and not installed.is_symlink()
                else:
                    ok = (installed.is_file() and not installed.is_symlink() and
                          installed.stat().st_mode & 0o111 == entry.stat().st_mode & 0o111 and
                          sha256(installed) == sha256(entry))
                require(ok, "Installed package differs from the reviewed archive; use a clean source copy")
        else:
            new.rename(modules)
    print("Verified", len(layout["packages"]), "frozen package instances in", scope)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", choices=["root", "desktop"])
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--output", type=Path, help="private empty directory for desktop packaging")
    args = parser.parse_args()
    try:
        restore(args.scope, args.cache, args.output)
    except (ValueError, OSError, KeyError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, "JS restore failed: " + str(error) + "\n")
