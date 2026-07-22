#!/usr/bin/env python3
"""Verify and optionally apply the pinned h11 chunk-framing patch."""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

from verify_patch import (
    HERE,
    VerificationError,
    load_manifest,
    patch_paths,
    run,
    sha256,
    verify_hashes,
)


def verify(args: argparse.Namespace) -> None:
    source = args.source.resolve()
    manifest = load_manifest()
    h11_source = manifest["h11_source"]
    patch_info = h11_source["patch"]
    patch = HERE / patch_info["path"]
    if not source.is_dir() or not patch.is_file():
        raise VerificationError("the h11 source directory or patch is missing")
    if sha256(patch) != patch_info["sha256"]:
        raise VerificationError("h11 patch identity mismatch")

    expected_paths = [entry["path"] for entry in patch_info["files"]]
    if patch_paths(patch) != expected_paths:
        raise VerificationError("h11 patch file list mismatch")
    verify_hashes(source, patch_info["files"], "before_sha256")

    temporary_directory: tempfile.TemporaryDirectory[str] | None = None
    working_source = source
    if not args.apply:
        temporary_directory = tempfile.TemporaryDirectory(
            prefix="maintainflow-h11-verify-"
        )
        working_source = Path(temporary_directory.name) / "source"
        shutil.copytree(source, working_source)

    try:
        run(
            "git",
            "apply",
            "--check",
            "--whitespace=error-all",
            str(patch),
            cwd=working_source,
        )
        run(
            "git",
            "apply",
            "--whitespace=error-all",
            str(patch),
            cwd=working_source,
        )
        verify_hashes(working_source, patch_info["files"], "after_sha256")
    finally:
        if temporary_directory is not None:
            temporary_directory.cleanup()

    action = "verified and applied" if args.apply else "verified"
    print(
        f"{action} h11 {h11_source['version']} chunk-framing patch "
        f"{patch_info['sha256']}"
    )
    if args.test:
        interpreter = args.python.expanduser().absolute()
        if not interpreter.is_file():
            raise VerificationError(f"test interpreter does not exist: {interpreter}")
        run(
            str(interpreter),
            "-m",
            "pytest",
            "-q",
            *h11_source["focused_tests"],
            cwd=source,
            capture=False,
        )
        print("focused h11 chunk-framing tests passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    args = parser.parse_args()
    if args.test and not args.apply:
        parser.error("--test requires --apply")
    return args


def main() -> int:
    try:
        verify(parse_args())
    except VerificationError as error:
        print(f"verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
