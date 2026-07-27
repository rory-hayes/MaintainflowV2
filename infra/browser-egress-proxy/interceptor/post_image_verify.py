#!/usr/bin/env python3
"""Fail-closed post-install verification for the patched interceptor runtime."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read runtime identity file {path}") from error


def verify(manifest_path: Path) -> None:
    manifest = load_json(manifest_path)
    if manifest.get("schema_version") != 2:
        raise RuntimeError("unsupported pinned source manifest")
    expected_versions = {
        "h11": manifest["h11_source"]["version"],
        "mitmproxy": "12.2.3",
    }
    actual_versions = {
        package: importlib.metadata.version(package) for package in expected_versions
    }
    if actual_versions != expected_versions:
        raise RuntimeError(
            f"patched runtime version mismatch: expected {expected_versions}, got {actual_versions}"
        )

    import h11
    import mitmproxy
    from h11 import _readers as h11_readers
    from mitmproxy.proxy.layers import http as http_layer
    from mitmproxy.proxy.layers.http import _http1, _http_h2

    if (
        getattr(_http1, "MAX_HTTP1_HEADER_BYTES", None) != 64 * 1024
        or getattr(_http_h2, "MAX_HTTP2_HEADER_LIST_BYTES", None) != 64 * 1024
        or getattr(http_layer, "MAINTAINFLOW_STREAM_LIMITS_PATCHED", None) is not True
        or getattr(http_layer, "MAINTAINFLOW_MAX_REQUEST_BODY_BYTES", None)
        != 2 * 1024 * 1024
        or getattr(http_layer, "MAINTAINFLOW_MAX_RESPONSE_BODY_BYTES", None)
        != 20 * 1024 * 1024
        or getattr(h11_readers, "MAINTAINFLOW_MAX_CHUNK_HEADER_BYTES", None)
        != 64 * 1024
        or getattr(h11_readers, "MAINTAINFLOW_MAX_CHUNK_TRAILER_BYTES", None)
        != 64 * 1024
    ):
        raise RuntimeError("one or more patched runtime sentinels are absent")

    roots = {
        "h11/": Path(h11.__file__).resolve().parent.parent,
        "mitmproxy/": Path(mitmproxy.__file__).resolve().parent.parent,
    }
    file_contracts = [
        *manifest["h11_source"]["patch"]["files"],
        *[
            entry
            for patch_info in manifest["mitmproxy_patches"]
            for entry in patch_info["files"]
        ],
    ]
    for entry in file_contracts:
        relative = entry["path"]
        if relative.startswith("test/") or "/tests/" in relative:
            continue
        prefix = next((value for value in roots if relative.startswith(value)), None)
        if prefix is None:
            continue
        installed = roots[prefix] / relative
        if not installed.is_file() or sha256(installed) != entry["after_sha256"]:
            raise RuntimeError(f"installed patched source mismatch for {relative}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).resolve().parent / "pinned-source.json",
    )
    return parser.parse_args()


def main() -> int:
    try:
        verify(parse_args().manifest.resolve())
    except (RuntimeError, OSError) as error:
        print(f"post-image verification failed: {error}", file=sys.stderr)
        return 1
    print("patched interceptor runtime verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
