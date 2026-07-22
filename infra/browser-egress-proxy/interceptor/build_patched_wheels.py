#!/usr/bin/env python3
"""Build and attest the two exact patched wheels used by the interceptor image."""

from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "pinned-source.json"
MAX_SOURCE_ARCHIVE_BYTES = 2 * 1024 * 1024


class BuildError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(*command: str, cwd: Path, env: dict[str, str] | None = None) -> None:
    try:
        subprocess.run(command, cwd=cwd, env=env, check=True)
    except subprocess.CalledProcessError as error:
        raise BuildError(
            f"command failed ({error.returncode}): {' '.join(command)}"
        ) from error


def load_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BuildError("cannot read the pinned source manifest") from error
    if manifest.get("schema_version") != 2:
        raise BuildError("unsupported pinned source manifest")
    return manifest


def download_exact(url: str, destination: Path, expected_hash: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "MaintainFlowBuild/1"})
    digest = hashlib.sha256()
    size = 0
    try:
        with (
            urllib.request.urlopen(request, timeout=30) as response,
            destination.open("wb") as output,
        ):
            while chunk := response.read(64 * 1024):
                size += len(chunk)
                if size > MAX_SOURCE_ARCHIVE_BYTES:
                    raise BuildError(
                        "source archive exceeded the bounded download size"
                    )
                digest.update(chunk)
                output.write(chunk)
    except OSError as error:
        raise BuildError("could not download the pinned source archive") from error
    if digest.hexdigest() != expected_hash:
        raise BuildError("source archive hash mismatch")


def extract_h11(archive: Path, destination: Path, version: str) -> Path:
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            bundle.extractall(destination, filter="data")
    except (OSError, tarfile.TarError) as error:
        raise BuildError("could not safely extract the pinned h11 source") from error
    source = destination / f"h11-{version}"
    if not source.is_dir():
        raise BuildError("the h11 archive did not contain the expected root directory")
    return source


def verify_wheel_contents(
    wheel: Path, package_prefix: str, files: list[dict[str, str]]
) -> None:
    try:
        with zipfile.ZipFile(wheel) as archive:
            names = set(archive.namelist())
            for entry in files:
                source_path = entry["path"]
                if source_path.startswith("test/") or "/tests/" in source_path:
                    continue
                if not source_path.startswith(package_prefix):
                    continue
                wheel_path = source_path.removeprefix(package_prefix)
                if wheel_path not in names:
                    raise BuildError(f"patched wheel is missing {wheel_path}")
                actual = hashlib.sha256(archive.read(wheel_path)).hexdigest()
                if actual != entry["after_sha256"]:
                    raise BuildError(f"patched wheel content mismatch for {wheel_path}")
    except zipfile.BadZipFile as error:
        raise BuildError(f"invalid wheel archive: {wheel.name}") from error


def verify_wheel_dependency_metadata(wheel: Path, expected: list[str]) -> None:
    try:
        with zipfile.ZipFile(wheel) as archive:
            metadata_names = [
                name
                for name in archive.namelist()
                if name.endswith(".dist-info/METADATA")
            ]
            if len(metadata_names) != 1:
                raise BuildError(
                    f"expected one wheel METADATA file, found {len(metadata_names)}"
                )
            message = email.parser.Parser().parsestr(
                archive.read(metadata_names[0]).decode("utf-8")
            )
            requirements = set(message.get_all("Requires-Dist", []))
            missing = sorted(set(expected) - requirements)
            if missing:
                raise BuildError(
                    "patched wheel dependency metadata mismatch: " + ", ".join(missing)
                )
    except (UnicodeDecodeError, zipfile.BadZipFile) as error:
        raise BuildError(f"invalid wheel metadata: {wheel.name}") from error


def one_wheel(output: Path, pattern: str) -> Path:
    matches = sorted(output.glob(pattern))
    if len(matches) != 1:
        raise BuildError(f"expected one {pattern} wheel, found {len(matches)}")
    return matches[0]


def build(args: argparse.Namespace) -> None:
    manifest = load_manifest()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise BuildError("output directory must be empty")

    with tempfile.TemporaryDirectory(prefix="maintainflow-patched-runtime-") as value:
        work = Path(value)
        mitmproxy_source = work / "mitmproxy"
        upstream = manifest["upstream"]
        clone_environment = dict(os.environ)
        clone_environment["GIT_TERMINAL_PROMPT"] = "0"
        run(
            "git",
            "clone",
            "--quiet",
            "--filter=blob:none",
            "--no-checkout",
            upstream["repository"],
            str(mitmproxy_source),
            cwd=work,
            env=clone_environment,
        )
        run("git", "checkout", "--quiet", upstream["commit"], cwd=mitmproxy_source)

        h11_info = manifest["h11_source"]
        h11_archive = work / f"h11-{h11_info['version']}.tar.gz"
        download_exact(h11_info["sdist_url"], h11_archive, h11_info["sdist_sha256"])
        h11_source = extract_h11(h11_archive, work, h11_info["version"])

        mitmproxy_verify = [
            sys.executable,
            str(HERE / "verify_patch.py"),
            "--source",
            str(mitmproxy_source),
            "--apply",
        ]
        h11_verify = [
            sys.executable,
            str(HERE / "verify_h11_patch.py"),
            "--source",
            str(h11_source),
            "--apply",
        ]
        if args.test:
            mitmproxy_verify.extend(["--test", "--python", sys.executable])
            h11_verify.extend(["--test", "--python", sys.executable])
        run(*mitmproxy_verify, cwd=HERE)
        run(*h11_verify, cwd=HERE)

        source_date_epoch = subprocess.check_output(
            ["git", "show", "-s", "--format=%ct", upstream["commit"]],
            cwd=mitmproxy_source,
            text=True,
        ).strip()
        build_environment = dict(os.environ)
        build_environment.update(
            {
                "PYTHONHASHSEED": "0",
                "SOURCE_DATE_EPOCH": source_date_epoch,
            }
        )
        for source in (h11_source, mitmproxy_source):
            run(
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--disable-pip-version-check",
                "--no-deps",
                "--no-build-isolation",
                "--wheel-dir",
                str(output),
                str(source),
                cwd=work,
                env=build_environment,
            )

        h11_wheel = one_wheel(output, "h11-0.16.0-*.whl")
        mitmproxy_wheel = one_wheel(output, "mitmproxy-12.2.3-*.whl")
        verify_wheel_contents(h11_wheel, "", h11_info["patch"]["files"])
        verify_wheel_contents(
            mitmproxy_wheel,
            "",
            [
                entry
                for patch_info in manifest["mitmproxy_patches"]
                for entry in patch_info["files"]
                if entry["path"].startswith("mitmproxy/")
            ],
        )
        verify_wheel_dependency_metadata(
            mitmproxy_wheel, manifest["mitmproxy_metadata_contract"]
        )

        attestation = {
            "schema_version": 1,
            "source_date_epoch": int(source_date_epoch),
            "sources": {
                "mitmproxy_commit": upstream["commit"],
                "mitmproxy_patches": [
                    {"name": item["name"], "sha256": item["sha256"]}
                    for item in manifest["mitmproxy_patches"]
                ],
                "h11_sdist_sha256": h11_info["sdist_sha256"],
                "h11_patch_sha256": h11_info["patch"]["sha256"],
            },
            "artifacts": [
                {
                    "filename": wheel.name,
                    "sha256": sha256(wheel),
                    "size": wheel.stat().st_size,
                }
                for wheel in sorted((h11_wheel, mitmproxy_wheel))
            ],
        }
        (output / "patched-runtime-manifest.json").write_text(
            json.dumps(attestation, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        shutil.copy2(MANIFEST_PATH, output / "pinned-source.json")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--test",
        action="store_true",
        help="run the pinned focused suites before building",
    )
    return parser.parse_args()


def main() -> int:
    try:
        build(parse_args())
    except BuildError as error:
        print(f"patched runtime build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
