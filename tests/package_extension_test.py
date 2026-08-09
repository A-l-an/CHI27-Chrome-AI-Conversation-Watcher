#!/usr/bin/env python3
"""Independent checks for deterministic extension packaging."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path, PurePosixPath
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "package_extension", ROOT / "scripts" / "package_extension.py"
)
PACKAGE_EXTENSION = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(PACKAGE_EXTENSION)

TEST_METADATA = {
    "repository": "A-l-an/CHI27-Chrome-AI-Conversation-Watcher",
    "source_commit": "b" * 40,
    "platform": "Windows",
    "architecture": "X64",
    "release_stage": "local_validation",
}


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


def run_command(command: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )


def create_clean_checkout(parent: Path) -> tuple[Path, str]:
    repo = parent / "repo"
    shutil.copytree(
        ROOT,
        repo,
        ignore=shutil.ignore_patterns(".git", "dist", "__pycache__", ".DS_Store"),
    )
    commands = [
        ["git", "init", "-q"],
        [
            "git",
            "remote",
            "add",
            "origin",
            "https://github.com/A-l-an/CHI27-Chrome-AI-Conversation-Watcher.git",
        ],
        ["git", "add", "."],
        [
            "git",
            "-c",
            "user.name=CHI27 Test",
            "-c",
            "user.email=chi27-test@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
    ]
    for command in commands:
        result = run_command(command, repo)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
    head = run_command(["git", "rev-parse", "HEAD"], repo)
    if head.returncode != 0:
        raise AssertionError(head.stderr)
    return repo, head.stdout.strip()


def rewrite_self_consistent_artifact(
    artifact_dir: Path,
    changed_files: dict[str, bytes] | None = None,
    extra_files: dict[str, bytes] | None = None,
    removed_files: set[str] | None = None,
    source_commit: str | None = None,
) -> None:
    archive = next(artifact_dir.glob("*.zip"))
    sidecar = next(artifact_dir.glob("*.sha256"))
    build_manifest = next(artifact_dir.glob("*.manifest.json"))
    prefix = f"{archive.stem}/"
    with zipfile.ZipFile(archive) as handle:
        payloads = {
            name[len(prefix):]: handle.read(name)
            for name in handle.namelist()
        }
    for relative in removed_files or set():
        payloads.pop(relative)
    payloads.update(changed_files or {})
    payloads.update(extra_files or {})
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as handle:
        for relative in sorted(payloads):
            info = zipfile.ZipInfo(
                f"{prefix}{relative}",
                PACKAGE_EXTENSION.FIXED_ZIP_TIME,
            )
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            handle.writestr(info, payloads[relative])
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    sidecar.write_bytes(f"{digest}  {archive.name}\n".encode("ascii"))
    manifest = json.loads(build_manifest.read_text(encoding="utf-8"))
    manifest["sha256"] = digest
    manifest["files"] = sorted(payloads)
    manifest["file_count"] = len(payloads)
    if source_commit is not None:
        manifest["source_commit"] = source_commit
    build_manifest.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


class PackageExtensionTest(unittest.TestCase):
    def test_closure_is_complete_private_free_and_reproducible(self) -> None:
        with tempfile.TemporaryDirectory(prefix="chi27-chrome-package-") as temp:
            first_dir = Path(temp) / "first"
            second_dir = Path(temp) / "second"
            first_zip, first_sidecar, first_manifest = PACKAGE_EXTENSION.package(
                first_dir,
                TEST_METADATA,
            )
            second_zip, _, second_manifest = PACKAGE_EXTENSION.package(
                second_dir,
                TEST_METADATA,
            )
            first_sha = hashlib.sha256(first_zip.read_bytes()).hexdigest()
            second_sha = hashlib.sha256(second_zip.read_bytes()).hexdigest()
            self.assertEqual(first_sha, second_sha)
            self.assertEqual(first_manifest.read_bytes(), second_manifest.read_bytes())

            build = json.loads(first_manifest.read_text(encoding="utf-8"))
            self.assertEqual(build["sha256"], first_sha)
            self.assertEqual(build["schema_version"], "1.1")
            self.assertEqual(build["artifact_kind"], "unpacked_extension_source")
            self.assertEqual(build["repository"], TEST_METADATA["repository"])
            self.assertEqual(build["source_commit"], TEST_METADATA["source_commit"])
            self.assertEqual(build["platform"], TEST_METADATA["platform"])
            self.assertEqual(build["architecture"], TEST_METADATA["architecture"])
            self.assertEqual(build["version"], "0.2.11")
            self.assertEqual(build["extension_version"], "0.2.11")
            self.assertIs(build["contains_research_data"], False)
            self.assertEqual(build["release_stage"], TEST_METADATA["release_stage"])
            self.assertEqual(build["platform_target"], "chrome_mv3")
            self.assertEqual(
                build["provenance"]["source_commit"],
                "dbfcf631ad838af1b104f18903d32303aa1e5e1f",
            )
            self.assertNotIn("source_path", build)
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

            verify_command = [
                sys.executable,
                str(ROOT / "scripts" / "verify_extension_artifact.py"),
                "--artifact-dir",
                str(first_dir),
                "--repository",
                TEST_METADATA["repository"],
                "--source-commit",
                TEST_METADATA["source_commit"],
                "--platform",
                TEST_METADATA["platform"],
                "--architecture",
                TEST_METADATA["architecture"],
                "--release-stage",
                TEST_METADATA["release_stage"],
                "--verification-mode",
                "artifact-only",
            ]
            verified = subprocess.run(
                verify_command,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertEqual(
                json.loads(verified.stdout)["status"],
                "verified_artifact_contract_only",
            )
            self.assertIs(
                json.loads(verified.stdout)["checkout_bound"],
                False,
            )

            first_sidecar.write_text(
                f"{'0' * 64}  {first_zip.name}\n",
                encoding="ascii",
            )
            rejected = subprocess.run(
                verify_command,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn(
                "checksum sidecar is not the exact LF contract",
                rejected.stderr,
            )

    @mock.patch.dict(
        os.environ,
        {
            "GITHUB_ACTIONS": "true",
            "CHI27_ARTIFACT_REPOSITORY":
                "A-l-an/CHI27-Chrome-AI-Conversation-Watcher",
            "CHI27_ARTIFACT_SOURCE_COMMIT": "c" * 40,
            "CHI27_ARTIFACT_RELEASE_STAGE": "source_validation",
            "RUNNER_OS": "macOS",
            "RUNNER_ARCH": "ARM64",
        },
        clear=True,
    )
    def test_ci_metadata_is_injected_from_closed_environment(self) -> None:
        self.assertEqual(
            PACKAGE_EXTENSION.resolve_artifact_metadata(),
            {
                "repository": "A-l-an/CHI27-Chrome-AI-Conversation-Watcher",
                "source_commit": "c" * 40,
                "platform": "macOS",
                "architecture": "ARM64",
                "release_stage": "source_validation",
            },
        )

    def test_release_metadata_rejects_wrong_or_open_values(self) -> None:
        invalid_cases = [
            dict(TEST_METADATA, repository="someone-else/repository"),
            dict(TEST_METADATA, source_commit="short"),
            dict(TEST_METADATA, platform="Darwin"),
            dict(TEST_METADATA, architecture="unknown"),
            dict(TEST_METADATA, release_stage="participant_release"),
            dict(TEST_METADATA, contains_research_data="false"),
            {},
        ]
        for metadata in invalid_cases:
            with self.subTest(metadata=metadata):
                with self.assertRaises(PACKAGE_EXTENSION.PackageError):
                    PACKAGE_EXTENSION.validate_artifact_metadata(metadata)

    def test_checkout_binding_rejects_self_consistent_forgery_and_dirty_tree(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="chi27-chrome-binding-") as temp:
            temp_root = Path(temp)
            repo, head = create_clean_checkout(temp_root)
            baseline = temp_root / "baseline"
            package_command = [
                sys.executable,
                str(repo / "scripts" / "package_extension.py"),
                "--output-dir",
                str(baseline),
                "--repository",
                TEST_METADATA["repository"],
                "--source-commit",
                head,
                "--platform",
                "Windows",
                "--architecture",
                "X64",
                "--release-stage",
                "source_validation",
            ]
            packaged = run_command(package_command, repo)
            self.assertEqual(packaged.returncode, 0, packaged.stderr)

            def verify(directory: Path, source_commit: str = head):
                return run_command(
                    [
                        sys.executable,
                        str(repo / "scripts" / "verify_extension_artifact.py"),
                        "--artifact-dir",
                        str(directory),
                        "--repo-root",
                        str(repo),
                        "--repository",
                        TEST_METADATA["repository"],
                        "--source-commit",
                        source_commit,
                        "--platform",
                        "Windows",
                        "--architecture",
                        "X64",
                        "--release-stage",
                        "source_validation",
                    ],
                    repo,
                )

            verified = verify(baseline)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            evidence = json.loads(verified.stdout)
            self.assertEqual(evidence["status"], "verified_source_checkout")
            self.assertIs(evidence["checkout_bound"], True)
            self.assertIs(evidence["commit_content_bound"], True)
            self.assertEqual(evidence["checkout_head"], head)

            participant = temp_root / "participant"
            shutil.copytree(baseline, participant)
            rewrite_self_consistent_artifact(
                participant,
                extra_files={
                    "participant_records.json":
                        b'{"participant":"P01","path":"/Users/alan/private"}'
                },
            )
            rejected = verify(participant)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("forbidden member", rejected.stderr)

            tampered = temp_root / "tampered"
            shutil.copytree(baseline, tampered)
            rewrite_self_consistent_artifact(
                tampered,
                changed_files={
                    "content.js":
                        (repo / "content.js").read_bytes() + b"\n// tampered\n"
                },
            )
            rejected = verify(tampered)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("archive", rejected.stderr)
            self.assertIn("checkout", rejected.stderr)

            local_path = temp_root / "local-path"
            shutil.copytree(baseline, local_path)
            rewrite_self_consistent_artifact(
                local_path,
                changed_files={
                    "content.js":
                        (repo / "content.js").read_bytes()
                        + b'\nconst leakedPath = "/Users/alan/private";\n'
                },
            )
            rejected = verify(local_path)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("local absolute path", rejected.stderr)

            missing = temp_root / "missing"
            shutil.copytree(baseline, missing)
            rewrite_self_consistent_artifact(
                missing,
                removed_files={"content.js"},
            )
            rejected = verify(missing)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("runtime closure", rejected.stderr)

            wrong_commit = temp_root / "wrong-commit"
            shutil.copytree(baseline, wrong_commit)
            claimed_commit = "d" * 40
            rewrite_self_consistent_artifact(
                wrong_commit,
                source_commit=claimed_commit,
            )
            rejected = verify(wrong_commit, claimed_commit)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("does not match checkout HEAD", rejected.stderr)

            source_file = repo / "content.js"
            source_file.write_bytes(source_file.read_bytes() + b"\n// dirty fixture\n")
            rejected = verify(baseline)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("source-validation checkout is dirty", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
