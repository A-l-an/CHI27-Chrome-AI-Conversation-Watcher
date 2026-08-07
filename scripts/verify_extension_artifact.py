#!/usr/bin/env python3
"""Verify a packaged Chrome source artifact against the release contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath

from package_extension import (
    CANONICAL_REPOSITORY,
    ROOT,
    PackageError,
    build_closure,
    resolve_artifact_metadata,
)


MANIFEST_KEYS = {
    "schema_version",
    "artifact_kind",
    "archive",
    "sha256",
    "repository",
    "source_commit",
    "platform",
    "architecture",
    "version",
    "extension_version",
    "contains_research_data",
    "release_stage",
    "platform_target",
    "provenance",
    "file_count",
    "files",
}
PROVENANCE_KEYS = {
    "source_repository",
    "source_commit",
    "source_tree",
}
FORBIDDEN_NAMES = {
    ".env",
    "participant_config.json",
    "participant_records.json",
    "participant-records.json",
    "research_data.json",
    "research-data.json",
    "export_data.json",
    "export-data.json",
    "private_locator.json",
    "private-locator.json",
    "rta_private_return_cues.json",
}
FORBIDDEN_SUFFIXES = {
    ".csv",
    ".db",
    ".jsonl",
    ".key",
    ".log",
    ".mov",
    ".mp3",
    ".mp4",
    ".p12",
    ".pem",
    ".pfx",
    ".sqlite",
    ".sqlite3",
    ".wav",
    ".webm",
}
SENSITIVE_PATH_COMPONENTS = {
    "participant_data",
    "participant_records",
    "participants",
    "research_data",
    "research_records",
    "exports",
    "logs",
    "private_locator",
    "private_locators",
}
TEXT_SUFFIXES = {
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsonl",
    ".log",
    ".md",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
SENSITIVE_DATA_SUFFIXES = {
    ".csv",
    ".db",
    ".json",
    ".jsonl",
    ".log",
    ".md",
    ".sqlite",
    ".sqlite3",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
LOCAL_ABSOLUTE_PATH_PATTERNS = (
    re.compile(
        rb"(?:file://)?/(?:Users|home|Volumes)/[A-Za-z0-9._-]+/",
        re.IGNORECASE,
    ),
    re.compile(rb"(?:file://)?/private/(?:tmp|var)/", re.IGNORECASE),
    re.compile(rb"[A-Za-z]:\\\\Users\\\\", re.IGNORECASE),
)


class VerificationError(RuntimeError):
    pass


def one_file(artifact_dir: Path, pattern: str) -> Path:
    matches = sorted(artifact_dir.glob(pattern))
    if len(matches) != 1 or not matches[0].is_file():
        raise VerificationError(f"expected exactly one {pattern} file")
    return matches[0]


def unsafe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        path.is_absolute()
        or ".." in path.parts
        or "\\" in name
        or bool(re.match(r"^[A-Za-z]:", name))
    )


def forbidden_member(name: str) -> bool:
    path = PurePosixPath(name)
    lowered = name.lower()
    normalized_stem = re.sub(r"[-.]+", "_", path.stem.lower())
    normalized_parts = {
        re.sub(r"[-.]+", "_", part.lower())
        for part in path.parts[:-1]
    }
    sensitive_data_name = (
        path.suffix.lower() in SENSITIVE_DATA_SUFFIXES
        and bool(
            re.match(
                r"^(?:participants?|research|exports?|logs?|private_locators?)(?:_|$)",
                normalized_stem,
            )
        )
    )
    return (
        path.name.lower() in FORBIDDEN_NAMES
        or path.suffix.lower() in FORBIDDEN_SUFFIXES
        or sensitive_data_name
        or bool(normalized_parts & SENSITIVE_PATH_COMPONENTS)
        or "/tests/" in f"/{lowered}"
        or "/scripts/" in f"/{lowered}"
    )


def contains_local_absolute_path(name: str, payload: bytes) -> bool:
    if PurePosixPath(name).suffix.lower() not in TEXT_SUFFIXES:
        return False
    normalized = payload.replace(b"\\/", b"/")
    normalized = re.sub(rb"%2f", b"/", normalized, flags=re.IGNORECASE)
    normalized = re.sub(rb"\\u002f", b"/", normalized, flags=re.IGNORECASE)
    normalized = re.sub(
        rb"\\u005c",
        lambda _match: b"\\",
        normalized,
        flags=re.IGNORECASE,
    )
    return any(
        pattern.search(normalized)
        for pattern in LOCAL_ABSOLUTE_PATH_PATTERNS
    )


def git_output(repo_root: Path, arguments: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise VerificationError("checkout Git metadata is unavailable")
    return result.stdout.strip()


def normalize_github_origin(value: str) -> str:
    match = re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:)([^/]+/[^/]+?)(?:\.git)?/?",
        value.strip(),
    )
    return match.group(1) if match else ""


def verify_checkout_binding(
    repo_root: Path,
    manifest: dict,
    archive_files: list[str],
    archive_payloads: dict[str, bytes],
    archive_sizes: dict[str, int],
) -> dict[str, object]:
    repo_root = repo_root.resolve()
    top_level = Path(git_output(repo_root, ["rev-parse", "--show-toplevel"])).resolve()
    if top_level != repo_root:
        raise VerificationError("repo root is not the checkout top level")
    origin = git_output(repo_root, ["remote", "get-url", "origin"])
    if normalize_github_origin(origin) != CANONICAL_REPOSITORY:
        raise VerificationError("checkout origin is not the canonical repository")
    head = git_output(repo_root, ["rev-parse", "HEAD"]).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise VerificationError("checkout HEAD is invalid")
    if manifest["source_commit"] != head:
        raise VerificationError("artifact source commit does not match checkout HEAD")
    dirty = bool(
        git_output(
            repo_root,
            ["status", "--porcelain=v1", "--untracked-files=all"],
        )
    )
    if manifest["release_stage"] == "source_validation" and dirty:
        raise VerificationError("source-validation checkout is dirty")

    expected_files = [item.as_posix() for item in build_closure(repo_root)]
    if archive_files != expected_files:
        raise VerificationError("archive members do not match the checkout runtime closure")
    for relative in expected_files:
        source = repo_root / Path(relative)
        if not source.is_file() or source.is_symlink():
            raise VerificationError("checkout closure contains an invalid source file")
        source_bytes = source.read_bytes()
        archive_bytes = archive_payloads[relative]
        if archive_sizes[relative] != len(source_bytes):
            raise VerificationError(f"archive size differs from checkout: {relative}")
        if hashlib.sha256(archive_bytes).digest() != hashlib.sha256(source_bytes).digest():
            raise VerificationError(f"archive hash differs from checkout: {relative}")
        if archive_bytes != source_bytes:
            raise VerificationError(f"archive bytes differ from checkout: {relative}")
    return {
        "checkout_bound": True,
        "checkout_clean": not dirty,
        "checkout_head": head,
        "commit_content_bound": not dirty,
        "checkout_file_count": len(expected_files),
    }


def verify(
    artifact_dir: Path,
    expected_metadata: dict[str, str],
    verification_mode: str = "checkout",
    repo_root: Path = ROOT,
) -> dict[str, object]:
    if verification_mode not in {"checkout", "artifact-only"}:
        raise VerificationError("verification mode is unsupported")
    entries = sorted(artifact_dir.iterdir(), key=lambda item: item.name)
    if len(entries) != 3 or not all(item.is_file() for item in entries):
        raise VerificationError("artifact directory must contain exactly three files")
    archive = one_file(artifact_dir, "*.zip")
    sidecar = one_file(artifact_dir, "*.sha256")
    build_manifest = one_file(artifact_dir, "*.manifest.json")
    stem = archive.stem
    if sidecar.stem != stem or build_manifest.name != f"{stem}.manifest.json":
        raise VerificationError("artifact triplet basenames do not match")

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    sidecar_bytes = sidecar.read_bytes()
    try:
        sidecar_text = sidecar_bytes.decode("ascii")
    except UnicodeDecodeError as error:
        raise VerificationError("checksum sidecar is not ASCII") from error
    expected_sidecar = f"{digest}  {archive.name}\n"
    if sidecar_text != expected_sidecar or b"\r" in sidecar_bytes:
        raise VerificationError("checksum sidecar is not the exact LF contract")

    manifest = json.loads(build_manifest.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or set(manifest) != MANIFEST_KEYS:
        raise VerificationError("build manifest does not use the closed schema")
    if not isinstance(manifest.get("provenance"), dict):
        raise VerificationError("build manifest provenance is invalid")
    if set(manifest["provenance"]) != PROVENANCE_KEYS:
        raise VerificationError("build manifest provenance is not closed")
    provenance = manifest["provenance"]
    if not re.fullmatch(
        r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
        provenance["source_repository"]
        if isinstance(provenance["source_repository"], str)
        else "",
    ):
        raise VerificationError("build manifest provenance repository is unsafe")
    for key in ("source_commit", "source_tree"):
        value = provenance[key] if isinstance(provenance[key], str) else ""
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            raise VerificationError(f"build manifest provenance {key} is invalid")
    if manifest["schema_version"] != "1.1":
        raise VerificationError("build manifest schema version is unsupported")
    if manifest["artifact_kind"] != "unpacked_extension_source":
        raise VerificationError("artifact kind is not unpacked extension source")
    if manifest["platform_target"] != "chrome_mv3":
        raise VerificationError("artifact platform target is not Chrome MV3")
    if manifest["contains_research_data"] is not False:
        raise VerificationError("artifact must declare contains_research_data=false")
    for key, value in expected_metadata.items():
        if manifest.get(key) != value:
            raise VerificationError(f"artifact metadata mismatch: {key}")
    if manifest["archive"] != archive.name or manifest["sha256"] != digest:
        raise VerificationError("build manifest does not bind the archive")
    if manifest["version"] != manifest["extension_version"]:
        raise VerificationError("artifact version fields disagree")
    if not isinstance(manifest["version"], str) or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]+){1,3}",
        manifest["version"],
    ):
        raise VerificationError("artifact version is invalid")
    expected_stem = (
        f"CHI27-Chrome-AI-Conversation-Watcher-{manifest['version']}"
        "-unpacked-extension"
    )
    if stem != expected_stem:
        raise VerificationError("artifact triplet does not use the canonical name")
    if (
        not isinstance(manifest["files"], list)
        or any(not isinstance(item, str) for item in manifest["files"])
        or manifest["files"] != sorted(set(manifest["files"]))
    ):
        raise VerificationError("build manifest file list is invalid")
    if (
        not isinstance(manifest["file_count"], int)
        or isinstance(manifest["file_count"], bool)
        or manifest["file_count"] != len(manifest["files"])
    ):
        raise VerificationError("build manifest file count is invalid")

    with zipfile.ZipFile(archive) as handle:
        infos = handle.infolist()
        names = [info.filename for info in infos]
        if handle.testzip() is not None:
            raise VerificationError("archive CRC verification failed")
        if names != sorted(names):
            raise VerificationError("archive members are not deterministically sorted")
        if len(names) != len(set(names)):
            raise VerificationError("archive contains duplicate members")
        if any(unsafe_member(name) for name in names):
            raise VerificationError("archive contains an unsafe path")
        if any(forbidden_member(name) for name in names):
            raise VerificationError("archive contains a forbidden member")
        if any(
            ((info.external_attr >> 16) & 0o170000) == 0o120000
            for info in infos
        ):
            raise VerificationError("archive contains a symbolic link")
        prefix = f"{stem}/"
        if not names or not all(name.startswith(prefix) for name in names):
            raise VerificationError("archive does not use one expected root")
        archive_files = [name[len(prefix):] for name in names]
        if archive_files != manifest["files"]:
            raise VerificationError("archive members do not match the manifest")
        if len(names) != manifest["file_count"]:
            raise VerificationError("archive member count does not match")
        archive_payloads = {
            relative: handle.read(f"{prefix}{relative}")
            for relative in archive_files
        }
        archive_sizes = {
            name[len(prefix):]: info.file_size
            for name, info in zip(names, infos)
        }
        if any(
            contains_local_absolute_path(relative, archive_payloads[relative])
            for relative in archive_files
        ):
            raise VerificationError("archive contains a local absolute path")
        if "manifest.json" not in archive_payloads:
            raise VerificationError("archive is missing the extension manifest")
        extension_manifest = json.loads(
            archive_payloads["manifest.json"].decode("utf-8")
        )
    if not isinstance(extension_manifest, dict):
        raise VerificationError("packaged extension manifest is invalid")
    if extension_manifest.get("manifest_version") != 3:
        raise VerificationError("packaged extension is not Manifest V3")
    if extension_manifest.get("version") != manifest["version"]:
        raise VerificationError("packaged extension version does not match")

    if verification_mode == "checkout":
        binding = verify_checkout_binding(
            repo_root,
            manifest,
            archive_files,
            archive_payloads,
            archive_sizes,
        )
        status = (
            "verified_source_checkout"
            if manifest["release_stage"] == "source_validation"
            else "verified_checkout_content"
        )
        verification_scope = "checkout_runtime_closure"
    else:
        binding = {
            "checkout_bound": False,
            "checkout_clean": None,
            "checkout_head": None,
            "commit_content_bound": False,
            "checkout_file_count": None,
        }
        status = "verified_artifact_contract_only"
        verification_scope = "artifact_contract_only"

    return {
        "status": status,
        "verification_scope": verification_scope,
        **binding,
        "artifact_kind": manifest["artifact_kind"],
        "archive": archive.name,
        "sha256": digest,
        "repository": manifest["repository"],
        "source_commit": manifest["source_commit"],
        "platform": manifest["platform"],
        "architecture": manifest["architecture"],
        "version": manifest["version"],
        "release_stage": manifest["release_stage"],
        "contains_research_data": manifest["contains_research_data"],
        "platform_target": manifest["platform_target"],
        "file_count": manifest["file_count"],
        "triplet": [item.name for item in entries],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--repository")
    parser.add_argument("--source-commit")
    parser.add_argument("--platform", dest="target_platform")
    parser.add_argument("--architecture")
    parser.add_argument("--release-stage")
    parser.add_argument(
        "--verification-mode",
        choices=("checkout", "artifact-only"),
        default="checkout",
    )
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        metadata = resolve_artifact_metadata(
            repository=args.repository,
            source_commit=args.source_commit,
            target_platform=args.target_platform,
            architecture=args.architecture,
            release_stage=args.release_stage,
        )
        result = verify(
            args.artifact_dir.resolve(),
            metadata,
            verification_mode=args.verification_mode,
            repo_root=args.repo_root.resolve(),
        )
    except (
        OSError,
        ValueError,
        PackageError,
        VerificationError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
    ) as error:
        print(f"artifact verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
