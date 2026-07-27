#!/usr/bin/env python3
"""Fail-closed identity, applicability, and focused-test verifier for the patch."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "pinned-source.json"


class VerificationError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(*args: str, cwd: Path, capture: bool = True) -> str:
    try:
        completed = subprocess.run(
            args,
            cwd=cwd,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except subprocess.CalledProcessError as exc:
        detail = "\n".join(
            part.strip() for part in (exc.stdout, exc.stderr) if part and part.strip()
        )
        raise VerificationError(
            f"command failed ({exc.returncode}): {' '.join(args)}"
            + (f"\n{detail}" if detail else "")
        ) from exc
    return completed.stdout.strip() if completed.stdout else ""


def load_manifest() -> dict[str, Any]:
    try:
        data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read {MANIFEST_PATH}: {exc}") from exc
    if data.get("schema_version") != 2:
        raise VerificationError("unsupported pinned-source.json schema")
    return data


def patch_paths(patch: Path) -> list[str]:
    paths: list[str] = []
    pattern = re.compile(r"^diff --git a/(.+) b/(.+)$")
    for line in patch.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            before, after = match.groups()
            if before != after:
                raise VerificationError(f"renames are not permitted in patch: {line}")
            paths.append(before)
    if not paths or len(paths) != len(set(paths)):
        raise VerificationError("patch file list is empty or contains duplicates")
    return paths


def verify_hashes(source: Path, files: list[dict[str, str]], field: str) -> None:
    for entry in files:
        target = source / entry["path"]
        if not target.is_file():
            raise VerificationError(f"missing pinned source file: {entry['path']}")
        actual = sha256(target)
        expected = entry[field]
        if actual != expected:
            raise VerificationError(
                f"{field} mismatch for {entry['path']}: expected {expected}, got {actual}"
            )


def verify_one_patch(source: Path, patch_info: dict[str, Any]) -> str:
    patch = HERE / patch_info["path"]
    if not patch.is_file():
        raise VerificationError(f"missing patch: {patch}")
    actual_patch_hash = sha256(patch)
    if actual_patch_hash != patch_info["sha256"]:
        raise VerificationError(
            f"patch identity mismatch: expected {patch_info['sha256']}, "
            f"got {actual_patch_hash}"
        )

    expected_paths = [entry["path"] for entry in patch_info["files"]]
    actual_paths = patch_paths(patch)
    if actual_paths != expected_paths:
        raise VerificationError(
            f"patch file list mismatch: expected {expected_paths}, got {actual_paths}"
        )

    verify_hashes(source, patch_info["files"], "before_sha256")
    run(
        "git",
        "apply",
        "--check",
        "--whitespace=error-all",
        str(patch),
        cwd=source,
    )
    run("git", "apply", "--whitespace=error-all", str(patch), cwd=source)
    verify_hashes(source, patch_info["files"], "after_sha256")
    return actual_patch_hash


def verify(args: argparse.Namespace) -> None:
    source = args.source.resolve()
    if not (source / ".git").exists():
        raise VerificationError(f"source is not a Git checkout: {source}")

    manifest = load_manifest()
    commit = run("git", "rev-parse", "HEAD", cwd=source)
    expected_commit = manifest["upstream"]["commit"]
    if commit != expected_commit:
        raise VerificationError(
            f"source commit mismatch: expected {expected_commit}, got {commit}"
        )

    status = run("git", "status", "--porcelain", "--untracked-files=no", cwd=source)
    if status:
        raise VerificationError(f"source has tracked changes before apply:\n{status}")

    expected_paths = sorted(
        entry["path"]
        for patch_info in manifest["mitmproxy_patches"]
        for entry in patch_info["files"]
    )
    if len(expected_paths) != len(set(expected_paths)):
        raise VerificationError("mitmproxy patches must touch disjoint file sets")

    temporary_directory: tempfile.TemporaryDirectory[str] | None = None
    working_source = source
    if not args.apply:
        temporary_directory = tempfile.TemporaryDirectory(
            prefix="maintainflow-mitmproxy-verify-"
        )
        working_source = Path(temporary_directory.name) / "source"
        shutil.copytree(
            source,
            working_source,
            ignore=shutil.ignore_patterns(
                ".git", ".venv", "__pycache__", ".pytest_cache"
            ),
        )

    try:
        patch_hashes = [
            verify_one_patch(working_source, patch_info)
            for patch_info in manifest["mitmproxy_patches"]
        ]
    finally:
        if temporary_directory is not None:
            temporary_directory.cleanup()

    if args.apply:
        changed = run(
            "git", "diff", "--name-only", "--diff-filter=ACMRTUXB", cwd=source
        ).splitlines()
        if changed != expected_paths:
            raise VerificationError(
                f"applied file list mismatch: expected {expected_paths}, got {changed}"
            )

    action = "verified and applied" if args.apply else "verified"
    print(
        f"{action} {len(patch_hashes)} mitmproxy patches "
        f"({', '.join(patch_hashes)}) for {manifest['upstream']['tag']} "
        f"({expected_commit})"
    )
    if args.test:
        interpreter = args.python.expanduser().absolute()
        if not interpreter.is_file():
            raise VerificationError(f"test interpreter does not exist: {interpreter}")
        dependency_probe = """
import importlib.metadata
import json
import sys

expected = json.loads(sys.argv[1])
if sys.version_info < (3, 12):
    raise SystemExit(f"Python 3.12+ required, got {sys.version.split()[0]}")
actual = {name: importlib.metadata.version(name) for name in expected}
if actual != expected:
    raise SystemExit(f"dependency mismatch: expected {expected}, got {actual}")
"""
        run(
            str(interpreter),
            "-c",
            dependency_probe,
            json.dumps(manifest["dependency_contract"], sort_keys=True),
            cwd=source,
        )
        run(
            str(interpreter),
            "-m",
            "pytest",
            "-q",
            *manifest["focused_tests"],
            cwd=source,
            capture=False,
        )
        print("focused mitmproxy hardening tests passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source", type=Path, required=True, help="clean mitmproxy source checkout"
    )
    parser.add_argument(
        "--apply", action="store_true", help="apply after all preimage checks pass"
    )
    parser.add_argument(
        "--test", action="store_true", help="run focused tests after applying"
    )
    parser.add_argument(
        "--python",
        type=Path,
        default=Path(sys.executable),
        help="Python 3.12+ interpreter with the pinned development dependencies",
    )
    args = parser.parse_args()
    if args.test and not args.apply:
        parser.error("--test requires --apply")
    return args


def main() -> int:
    try:
        verify(parse_args())
    except VerificationError as exc:
        print(f"verification failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
