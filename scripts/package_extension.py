#!/usr/bin/env python3
"""Build a deterministic unpacked-extension ZIP from the manifest closure."""

from __future__ import annotations

import argparse
import hashlib
import html.parser
import json
import os
import platform
import re
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
CANONICAL_REPOSITORY = "A-l-an/CHI27-Chrome-AI-Conversation-Watcher"
RELEASE_STAGES = {"local_validation", "source_validation"}
PLATFORMS = {"Windows", "macOS", "Linux"}
ARCHITECTURES = {"X64", "ARM64", "X86", "ARM"}
FORBIDDEN_NAMES = {
    ".env",
    "participant_config.json",
    "rta_private_return_cues.json",
}
FORBIDDEN_SUFFIXES = {".key", ".pem", ".p12", ".pfx"}
URL_PREFIXES = ("data:", "http:", "https:", "chrome:", "#", "//")


class PackageError(RuntimeError):
    pass


def current_git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    candidate = result.stdout.strip().lower()
    if result.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", candidate):
        raise PackageError(
            "source commit is unavailable; set CHI27_ARTIFACT_SOURCE_COMMIT"
        )
    return candidate


def local_platform() -> str:
    candidate = {
        "Darwin": "macOS",
        "Windows": "Windows",
        "Linux": "Linux",
    }.get(platform.system())
    if candidate is None:
        raise PackageError("local platform is unsupported")
    return candidate


def local_architecture() -> str:
    candidate = {
        "x86_64": "X64",
        "amd64": "X64",
        "arm64": "ARM64",
        "aarch64": "ARM64",
        "x86": "X86",
        "i386": "X86",
        "i686": "X86",
        "arm": "ARM",
    }.get(platform.machine().lower())
    if candidate is None:
        raise PackageError("local architecture is unsupported")
    return candidate


def validate_artifact_metadata(metadata: dict[str, str]) -> dict[str, str]:
    required = {
        "repository",
        "source_commit",
        "platform",
        "architecture",
        "release_stage",
    }
    if set(metadata) != required:
        raise PackageError("artifact metadata must use the closed release schema")
    normalized = {
        key: value.strip() if isinstance(value, str) else ""
        for key, value in metadata.items()
    }
    if normalized["repository"] != CANONICAL_REPOSITORY:
        raise PackageError("artifact repository does not match the canonical repository")
    normalized["source_commit"] = normalized["source_commit"].lower()
    if not re.fullmatch(r"[0-9a-f]{40}", normalized["source_commit"]):
        raise PackageError("artifact source commit must be a full Git SHA")
    if normalized["platform"] not in PLATFORMS:
        raise PackageError("artifact platform is unsupported")
    if normalized["architecture"] not in ARCHITECTURES:
        raise PackageError("artifact architecture is unsupported")
    if normalized["release_stage"] not in RELEASE_STAGES:
        raise PackageError("artifact release stage is unsupported")
    if (
        normalized["release_stage"] == "source_validation"
        and normalized["platform"] not in {"Windows", "macOS"}
    ):
        raise PackageError("source-validation artifacts require a workflow platform")
    return normalized


def resolve_artifact_metadata(
    repository: Optional[str] = None,
    source_commit: Optional[str] = None,
    target_platform: Optional[str] = None,
    architecture: Optional[str] = None,
    release_stage: Optional[str] = None,
) -> dict[str, str]:
    github_actions = os.environ.get("GITHUB_ACTIONS", "").lower() == "true"
    metadata = {
        "repository": (
            repository
            or os.environ.get("CHI27_ARTIFACT_REPOSITORY")
            or os.environ.get("GITHUB_REPOSITORY")
            or CANONICAL_REPOSITORY
        ),
        "source_commit": (
            source_commit
            or os.environ.get("CHI27_ARTIFACT_SOURCE_COMMIT")
            or os.environ.get("GITHUB_SHA")
            or current_git_head()
        ),
        "platform": (
            target_platform
            or os.environ.get("CHI27_ARTIFACT_PLATFORM")
            or os.environ.get("RUNNER_OS")
            or local_platform()
        ),
        "architecture": (
            architecture
            or os.environ.get("CHI27_ARTIFACT_ARCHITECTURE")
            or os.environ.get("RUNNER_ARCH")
            or local_architecture()
        ),
        "release_stage": (
            release_stage
            or os.environ.get("CHI27_ARTIFACT_RELEASE_STAGE")
            or ("source_validation" if github_actions else "local_validation")
        ),
    }
    return validate_artifact_metadata(metadata)


class AssetParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.paths: set[str] = set()

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name in {"src", "href", "poster"} and value:
                self.paths.add(value)


def clean_reference(value: str, base: PurePosixPath = PurePosixPath(".")) -> PurePosixPath | None:
    raw = value.strip().replace("\\", "/")
    if not raw or raw.startswith(URL_PREFIXES):
        return None
    if raw.startswith("/") or re.match(r"^[A-Za-z]:/", raw):
        raise PackageError(f"absolute path is forbidden: {value}")
    raw = raw.split("#", 1)[0].split("?", 1)[0]
    candidate = base / PurePosixPath(raw)
    parts: list[str] = []
    for part in candidate.parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not parts:
                raise PackageError(f"path escapes repository: {value}")
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        return None
    result = PurePosixPath(*parts)
    if result.is_absolute() or ".." in result.parts:
        raise PackageError(f"unsafe path: {value}")
    return result


def add_manifest_paths(manifest: dict, add, root: Path = ROOT) -> None:
    background = manifest.get("background", {})
    if isinstance(background, dict):
        if isinstance(background.get("service_worker"), str):
            add(background["service_worker"])
        for item in background.get("scripts", []):
            add(item)
    for script in manifest.get("content_scripts", []):
        for key in ("js", "css"):
            for item in script.get(key, []):
                add(item)
    for key in ("options_page", "devtools_page"):
        if isinstance(manifest.get(key), str):
            add(manifest[key])
    options_ui = manifest.get("options_ui", {})
    if isinstance(options_ui, dict) and isinstance(options_ui.get("page"), str):
        add(options_ui["page"])
    for key in ("action", "browser_action", "page_action", "side_panel"):
        section = manifest.get(key, {})
        if not isinstance(section, dict):
            continue
        for field in ("default_popup", "default_path"):
            if isinstance(section.get(field), str):
                add(section[field])
        icons = section.get("default_icon", {})
        if isinstance(icons, str):
            add(icons)
        elif isinstance(icons, dict):
            for item in icons.values():
                add(item)
    icons = manifest.get("icons", {})
    if isinstance(icons, dict):
        for item in icons.values():
            add(item)
    overrides = manifest.get("chrome_url_overrides", {})
    if isinstance(overrides, dict):
        for item in overrides.values():
            add(item)
    for entry in manifest.get("web_accessible_resources", []):
        for pattern in entry.get("resources", []):
            if not isinstance(pattern, str):
                continue
            clean = clean_reference(pattern)
            if clean is None:
                continue
            matches = sorted(root.glob(clean.as_posix()))
            if not matches:
                raise PackageError(f"web-accessible pattern matched nothing: {pattern}")
            for match in matches:
                if match.is_file():
                    add(match.relative_to(root).as_posix())


def referenced_assets(relative: PurePosixPath, payload: str) -> set[PurePosixPath]:
    found: set[PurePosixPath] = set()
    base = relative.parent
    if relative.suffix.lower() == ".html":
        parser = AssetParser()
        parser.feed(payload)
        values = parser.paths
    elif relative.suffix.lower() == ".css":
        values = set(re.findall(r"url\(\s*['\"]?([^)'\"]+)", payload, re.IGNORECASE))
    elif relative.suffix.lower() == ".js":
        blocks = re.findall(r"importScripts\s*\((.*?)\)\s*;", payload, re.DOTALL)
        values = {
            match
            for block in blocks
            for match in re.findall(r"['\"]([^'\"]+)['\"]", block)
        }
        # Worker importScripts URLs are resolved from the entry worker URL.
        base = PurePosixPath(".")
    else:
        values = set()
    for value in values:
        clean = clean_reference(value, base)
        if clean is not None:
            found.add(clean)
    return found


def build_closure(root: Path = ROOT) -> list[PurePosixPath]:
    root = root.resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pending: list[PurePosixPath] = []
    included: set[PurePosixPath] = set()

    def add(value: str | PurePosixPath) -> None:
        clean = clean_reference(str(value))
        if clean is not None and clean not in included and clean not in pending:
            pending.append(clean)

    add("manifest.json")
    add_manifest_paths(manifest, add, root)
    while pending:
        relative = pending.pop(0)
        source = root / Path(relative.as_posix())
        if not source.exists() or not source.is_file():
            raise PackageError(f"referenced file is missing: {relative}")
        if source.is_symlink():
            raise PackageError(f"symlinks are not packaged: {relative}")
        if relative.name.lower() in FORBIDDEN_NAMES or relative.suffix.lower() in FORBIDDEN_SUFFIXES:
            raise PackageError(f"forbidden file reached package closure: {relative}")
        included.add(relative)
        if relative.suffix.lower() in {".html", ".css", ".js"}:
            text = source.read_text(encoding="utf-8")
            for discovered in sorted(referenced_assets(relative, text), key=str):
                add(discovered)
    return sorted(included, key=lambda item: item.as_posix())


def package(
    output_dir: Path,
    artifact_metadata: Optional[dict[str, str]] = None,
) -> tuple[Path, Path, Path]:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        raise PackageError("manifest version is invalid")
    metadata = validate_artifact_metadata(
        artifact_metadata
        if artifact_metadata is not None
        else resolve_artifact_metadata()
    )
    files = build_closure()
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"CHI27-Chrome-AI-Conversation-Watcher-{version}-unpacked-extension"
    archive = output_dir / f"{stem}.zip"
    prefix = f"{stem}/"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as handle:
        for relative in files:
            info = zipfile.ZipInfo(prefix + relative.as_posix(), FIXED_ZIP_TIME)
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            handle.writestr(info, (ROOT / Path(relative.as_posix())).read_bytes())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    sidecar = output_dir / f"{stem}.sha256"
    sidecar.write_bytes(f"{digest}  {archive.name}\n".encode("utf-8"))
    provenance = json.loads((ROOT / "SOURCE_PROVENANCE.json").read_text(encoding="utf-8"))
    build_manifest = output_dir / f"{stem}.manifest.json"
    build_manifest.write_bytes(
        json.dumps(
            {
                "schema_version": "1.1",
                "artifact_kind": "unpacked_extension_source",
                "archive": archive.name,
                "sha256": digest,
                "repository": metadata["repository"],
                "source_commit": metadata["source_commit"],
                "platform": metadata["platform"],
                "architecture": metadata["architecture"],
                "version": version,
                "extension_version": version,
                "contains_research_data": False,
                "release_stage": metadata["release_stage"],
                "platform_target": "chrome_mv3",
                "provenance": {
                    "source_repository": provenance["source_repository"],
                    "source_commit": provenance["source_commit"],
                    "source_tree": provenance["source_tree"],
                },
                "file_count": len(files),
                "files": [item.as_posix() for item in files],
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ).encode("utf-8") + b"\n",
    )
    return archive, sidecar, build_manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--repository")
    parser.add_argument("--source-commit")
    parser.add_argument("--platform", dest="target_platform")
    parser.add_argument("--architecture")
    parser.add_argument("--release-stage")
    args = parser.parse_args()
    try:
        metadata = resolve_artifact_metadata(
            repository=args.repository,
            source_commit=args.source_commit,
            target_platform=args.target_platform,
            architecture=args.architecture,
            release_stage=args.release_stage,
        )
        archive, sidecar, build_manifest = package(
            args.output_dir.resolve(),
            metadata,
        )
    except (OSError, ValueError, PackageError, json.JSONDecodeError) as error:
        print(f"package failed: {error}", file=sys.stderr)
        return 1
    print(archive)
    print(sidecar)
    print(build_manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
