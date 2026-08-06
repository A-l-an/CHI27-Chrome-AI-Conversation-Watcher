#!/usr/bin/env python3
"""Independent checks for deterministic extension packaging."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "package_extension", ROOT / "scripts" / "package_extension.py"
)
PACKAGE_EXTENSION = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PACKAGE_EXTENSION)


def runtime_closure_references() -> set[str]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    expected = {"manifest.json"}
    background_files: list[PurePosixPath] = []
    background = manifest.get("background", {})
    if isinstance(background, dict):
        entries = []
        if isinstance(background.get("service_worker"), str):
            entries.append(background["service_worker"])
        entries.extend(
            item for item in background.get("scripts", [])
            if isinstance(item, str)
        )
        for item in entries:
            clean = PACKAGE_EXTENSION.clean_reference(item)
            if clean is not None:
                background_files.append(clean)
                expected.add(clean.as_posix())

    for entry in manifest.get("content_scripts", []):
        for key in ("js", "css"):
            for item in entry.get(key, []):
                clean = PACKAGE_EXTENSION.clean_reference(item)
                if clean is not None:
                    expected.add(clean.as_posix())

    for relative in background_files:
        payload = (ROOT / Path(relative.as_posix())).read_text(encoding="utf-8")
        blocks = re.findall(
            r"importScripts\s*\((.*?)\)\s*;",
            payload,
            re.DOTALL,
        )
        for block in blocks:
            for item in re.findall(r"['\"]([^'\"]+)['\"]", block):
                clean = PACKAGE_EXTENSION.clean_reference(item)
                if clean is not None:
                    expected.add(clean.as_posix())
    return expected


class PackageExtensionTest(unittest.TestCase):
    def test_closure_is_complete_private_free_and_reproducible(self) -> None:
        with tempfile.TemporaryDirectory(prefix="chi27-chrome-package-") as temp:
            first_dir = Path(temp) / "first"
            second_dir = Path(temp) / "second"
            first_zip, _, first_manifest = PACKAGE_EXTENSION.package(first_dir)
            second_zip, _, second_manifest = PACKAGE_EXTENSION.package(second_dir)
            first_sha = hashlib.sha256(first_zip.read_bytes()).hexdigest()
            second_sha = hashlib.sha256(second_zip.read_bytes()).hexdigest()
            self.assertEqual(first_sha, second_sha)
            self.assertEqual(first_manifest.read_bytes(), second_manifest.read_bytes())

            build = json.loads(first_manifest.read_text(encoding="utf-8"))
            self.assertEqual(build["sha256"], first_sha)
            self.assertEqual(build["artifact_kind"], "unpacked_extension_source")
            self.assertIn("manifest.json", build["files"])
            self.assertIn("background.js", build["files"])
            self.assertIn("content.js", build["files"])
            self.assertIn("participant_config.js", build["files"])
            self.assertNotIn("participant_config.json", build["files"])
            runtime_files = runtime_closure_references()
            build_files = set(build["files"])
            self.assertGreater(len(runtime_files), 1)
            self.assertTrue(
                runtime_files <= build_files,
                f"runtime closure missing from build manifest: "
                f"{sorted(runtime_files - build_files)}",
            )

            with zipfile.ZipFile(first_zip) as archive:
                names = archive.namelist()
                self.assertEqual(names, sorted(names))
                self.assertEqual(len(names), build["file_count"])
                prefix = f"{first_zip.stem}/"
                self.assertTrue(all(name.startswith(prefix) for name in names))
                archive_files = {
                    name[len(prefix):]
                    for name in names
                }
                self.assertEqual(archive_files, build_files)
                self.assertTrue(
                    runtime_files <= archive_files,
                    f"runtime closure missing from ZIP: "
                    f"{sorted(runtime_files - archive_files)}",
                )
                lowered = "\n".join(names).lower()
                self.assertNotIn("participant_config.json", lowered)
                self.assertNotIn("tests/", lowered)
                self.assertNotIn("scripts/", lowered)
                self.assertNotIn(".env", lowered)


if __name__ == "__main__":
    unittest.main()
