import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("restore_js", Path(__file__).resolve().parents[1] / "scripts/restore-js.py")
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreTests(unittest.TestCase):
    def test_layout_binds_both_manifests_and_locks(self):
        for scope in ("root", "desktop"):
            project, layout = restore.reviewed_layout(scope)
            self.assertEqual(layout["lockSha256"], restore.sha256(project / "pnpm-lock.yaml"))
            self.assertFalse(any(row[0] == "picomatch" for row in layout["packages"].values()))

    def test_cache_corruption_stops_before_extraction(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            expected = hashlib.sha512(b"reviewed").digest()
            (cache / (expected.hex() + ".tgz")).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                restore.get_archive(cache, "https://registry.npmjs.org/fixture", "sha512", expected, ".tgz")

    def test_exhausted_transfer_retries_leave_no_partial_archive(self):
        def interrupted_download(args, **kwargs):
            self.assertIn("--retry-all-errors", args)
            self.assertEqual(args[args.index("--speed-time") + 1], "60")
            self.assertEqual(args[args.index("--speed-limit") + 1], "1")
            Path(args[-1]).write_bytes(b"partial download")
            raise subprocess.CalledProcessError(18, args)

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            restore.subprocess, "run", side_effect=interrupted_download
        ):
            cache = Path(tmp)
            expected = hashlib.sha512(b"complete package").digest()
            with self.assertRaises(subprocess.CalledProcessError):
                restore.get_archive(cache, "https://registry.npmjs.org/fixture", "sha512", expected, ".tgz")
            self.assertFalse(list(cache.iterdir()))

    def test_duplicate_members_must_agree(self):
        for repeated, valid in [(b"identical", True), (b"changed", False)]:
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp) / "sample.tgz"
                dest = Path(tmp) / "files"
                with tarfile.open(archive, "w:gz") as tar:
                    for name, value in [("p/package.json", b'{"name":"fixture","version":"1.0.0"}'),
                                        ("p/./entry.js", b"identical"), ("p/entry.js", repeated)]:
                        info = tarfile.TarInfo(name)
                        info.size = len(value)
                        tar.addfile(info, io.BytesIO(value))
                if valid:
                    restore.extract_package(archive, dest, "fixture", "1.0.0")
                    self.assertEqual((dest / "entry.js").read_bytes(), b"identical")
                else:
                    with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
                        restore.extract_package(archive, dest, "fixture", "1.0.0")
