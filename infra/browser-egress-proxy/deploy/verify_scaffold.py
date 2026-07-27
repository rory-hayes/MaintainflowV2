#!/usr/bin/env python3
"""Static, network-free verification for the Fly deployment templates."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Sequence


DEPLOY_ROOT = Path(__file__).resolve().parent
_APP_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$")
_PINNED_IMAGE = re.compile(r"^[^\s]+@sha256:[0-9a-f]{64}$")
_SENSITIVE_ENV_PARTS = (
    "PASSWORD",
    "PRIVATE",
    "SECRET",
    "PEPPER",
    "HMAC",
    "TOKEN",
    "_B64",
)


class VerificationError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def _read_toml(path: Path) -> dict[str, Any]:
    """Parse the deliberately small TOML subset used by these two templates.

    Production validation still belongs to ``fly config validate``. This
    strict local parser exists so the fail-closed static checks stay hermetic
    on the macOS system Python, which does not include tomllib.
    """
    root: dict[str, Any] = {}
    current = root

    def descend(parts: list[str], *, append: bool) -> dict[str, Any]:
        node: dict[str, Any] = root
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            existing = node.get(part)
            if last and append:
                if existing is None:
                    existing = []
                    node[part] = existing
                if not isinstance(existing, list):
                    raise VerificationError(f"invalid Fly config table: {path.name}")
                child: dict[str, Any] = {}
                existing.append(child)
                return child
            if isinstance(existing, list):
                if not existing or not isinstance(existing[-1], dict):
                    raise VerificationError(f"invalid Fly config table: {path.name}")
                node = existing[-1]
                if last:
                    return node
                continue
            if existing is None:
                existing = {}
                node[part] = existing
            if not isinstance(existing, dict):
                raise VerificationError(f"invalid Fly config table: {path.name}")
            node = existing
        return node

    def parse_value(raw: str) -> Any:
        if raw.startswith('"') or raw.startswith("["):
            try:
                return json.loads(raw)
            except json.JSONDecodeError as error:
                raise VerificationError(f"invalid Fly config value: {path.name}") from error
        if raw == "true":
            return True
        if raw == "false":
            return False
        if re.fullmatch(r"-?[0-9]+", raw):
            return int(raw, 10)
        raise VerificationError(f"unsupported Fly config value: {path.name}")

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise VerificationError(f"invalid Fly config: {path.name}") from error
    for original in lines:
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[[") and line.endswith("]]" ):
            parts = line[2:-2].strip().split(".")
            current = descend(parts, append=True)
            continue
        if line.startswith("[") and line.endswith("]"):
            parts = line[1:-1].strip().split(".")
            current = descend(parts, append=False)
            continue
        if "=" not in line:
            raise VerificationError(f"invalid Fly config line: {path.name}")
        key, raw_value = (piece.strip() for piece in line.split("=", 1))
        if not re.fullmatch(r"[A-Za-z0-9_]+", key) or key in current:
            raise VerificationError(f"invalid or duplicate Fly config key: {path.name}")
        current[key] = parse_value(raw_value)
    return root


def _verify_restart(configuration: dict[str, Any], description: str) -> None:
    restarts = configuration.get("restart")
    _require(isinstance(restarts, list) and len(restarts) == 1, f"{description} needs one restart policy")
    _require(restarts[0] == {"policy": "on-failure", "retries": 10}, f"{description} restart policy drifted")


def _verify_no_secret_env(configuration: dict[str, Any], description: str) -> None:
    environment = configuration.get("env", {})
    _require(isinstance(environment, dict), f"{description} env must be a table")
    for name, value in environment.items():
        _require(isinstance(value, str), f"{description} env values must be strings")
        _require(
            not any(part in name.upper() for part in _SENSITIVE_ENV_PARTS),
            f"{description} config must not contain secret-like env values",
        )


def verify_fly_configs(
    interceptor_path: Path,
    dialer_path: Path,
    *,
    require_rendered: bool = False,
) -> None:
    interceptor = _read_toml(interceptor_path)
    dialer = _read_toml(dialer_path)

    interceptor_app = interceptor.get("app", "")
    dialer_app = dialer.get("app", "")
    _require(_APP_NAME.fullmatch(interceptor_app) is not None, "invalid interceptor app name")
    _require(_APP_NAME.fullmatch(dialer_app) is not None, "invalid dialer app name")
    _require(interceptor_app != dialer_app, "Fly apps must be distinct")
    if require_rendered:
        _require("replace-with-reviewed" not in interceptor_app, "interceptor app placeholder remains")
        _require("replace-with-reviewed" not in dialer_app, "dialer app placeholder remains")

    _require(interceptor.get("primary_region") == dialer.get("primary_region"), "Fly apps must start in one reviewed region")
    _require(interceptor.get("primary_region") == "fra", "Fly apps must use the contracted FRA region")
    for configuration, description in ((interceptor, "interceptor"), (dialer, "dialer")):
        _require(configuration.get("kill_signal") == "SIGTERM", f"{description} must use SIGTERM")
        _require(configuration.get("kill_timeout") == "30s", f"{description} kill timeout drifted")
        _verify_restart(configuration, description)
        _verify_no_secret_env(configuration, description)
        machines = configuration.get("vm")
        _require(isinstance(machines, list) and len(machines) == 1, f"{description} needs one VM profile")
        _require(
            machines[0].get("persist_rootfs") == "never",
            f"{description} root filesystem must remain ephemeral",
        )

    _require("http_service" not in interceptor, "interceptor must not use the implicit HTTP service")
    services = interceptor.get("services")
    _require(isinstance(services, list) and len(services) == 1, "interceptor needs exactly one service")
    service = services[0]
    _require(service.get("internal_port") == 8080, "interceptor internal port must be 8080")
    _require(service.get("protocol") == "tcp", "interceptor service must be TCP")
    _require(service.get("auto_stop_machines") == "off", "interceptor autostop must be off")
    _require(service.get("auto_start_machines") is False, "interceptor autostart must be off")
    ports = service.get("ports")
    _require(isinstance(ports, list) and len(ports) == 1, "interceptor needs exactly one public port")
    port = ports[0]
    _require(port.get("port") == 443, "interceptor public port must be 443")
    _require(port.get("handlers") == ["tls"], "interceptor must use TLS termination without Fly HTTP handling")
    tls = port.get("tls_options", {})
    _require(tls.get("alpn") == ["http/1.1"], "interceptor ALPN must be only HTTP/1.1")
    _require(tls.get("versions") == ["TLSv1.2", "TLSv1.3"], "interceptor TLS versions drifted")
    _require(tls.get("default_self_signed") is False, "self-signed edge fallback must be disabled")
    tcp_checks = service.get("tcp_checks")
    _require(isinstance(tcp_checks, list) and len(tcp_checks) == 1, "interceptor needs one routing check")

    forbidden_dialer_sections = {
        "services",
        "http_service",
        "checks",
        "metrics",
        "mounts",
        "statics",
    }
    _require(
        not forbidden_dialer_sections.intersection(dialer),
        "private dialer config contains an exposure or persistence section",
    )
    dialer_environment = dialer.get("env", {})
    _require(dialer_environment.get("MF_DIALER_HEALTH_ADDR") == "127.0.0.1:8081", "dialer health must be loopback-only")
    _require(
        dialer_environment.get("MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID")
        == "spiffe://maintainflow/interceptor",
        "dialer client identity drifted",
    )
    _require("MF_DIALER_DOT_RESOLVERS" not in dialer_environment, "resolver selection must not be committed")

    expected_dialer_host = f"{dialer_app}.internal"
    interceptor_environment = interceptor.get("env", {})
    _require(
        interceptor_environment.get("MF_PROXY_AUDIENCE")
        == "maintainflow-browser-egress",
        "signed proxy audience drifted",
    )
    _require(
        "MF_PROXY_VERIFY_KEYS_JSON" not in interceptor_environment,
        "proxy verification keys must not be committed before selection",
    )
    _require(
        interceptor_environment.get("MF_DIALER_CLIENT_SPIFFE_ID")
        == "spiffe://maintainflow/interceptor",
        "interceptor client identity drifted",
    )
    _require(interceptor_environment.get("MF_DIALER_SERVER_NAME") == expected_dialer_host, "interceptor private dialer name does not match app")
    _require(interceptor_environment.get("MF_DIALER_PROXY_URL") == f"https://{expected_dialer_host}:9443", "interceptor private dialer URL does not match app")

    expected_builds = {
        "interceptor": "infra/browser-egress-proxy/deploy/images/Dockerfile.interceptor",
        "dialer": "infra/browser-egress-proxy/deploy/images/Dockerfile.dialer",
    }
    _require(interceptor.get("build", {}).get("dockerfile") == expected_builds["interceptor"], "interceptor Dockerfile path drifted")
    _require(dialer.get("build", {}).get("dockerfile") == expected_builds["dialer"], "dialer Dockerfile path drifted")


def _dockerfile_image_args(path: Path) -> list[str]:
    images: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("ARG ") or "_IMAGE=" not in line:
            continue
        images.append(line.split("=", 1)[1])
    return images


def verify_files() -> None:
    interceptor_dockerfile = DEPLOY_ROOT / "images/Dockerfile.interceptor"
    dialer_dockerfile = DEPLOY_ROOT / "images/Dockerfile.dialer"
    for path in (interceptor_dockerfile, dialer_dockerfile):
        contents = path.read_text(encoding="utf-8")
        images = _dockerfile_image_args(path)
        _require(images and all(_PINNED_IMAGE.fullmatch(image) for image in images), f"{path.name} base images must be digest-pinned")
        _require("apt-get upgrade --yes" in contents, f"{path.name} must install the current Debian security updates")
        _require("nftables" in contents and "util-linux" in contents, f"{path.name} lacks firewall/drop-privilege tools")
        _require("USER 0:0" in contents, f"{path.name} must enter through the root setup wrapper")
        _require("ENTRYPOINT" in contents, f"{path.name} lacks a fixed entrypoint")

    interceptor_contents = interceptor_dockerfile.read_text(encoding="utf-8")
    _require(
        interceptor_contents.count("--no-deps") >= 3,
        "interceptor dependency installation must use only the fully locked wheel set",
    )
    _require("apt-get purge --allow-remove-essential --yes" in interceptor_contents, "interceptor must strip unused base packages")
    for package in (
        "bsdutils",
        "gzip",
        "libblkid1",
        "liblastlog2-2",
        "libmount1",
        "libncursesw6",
        "libsmartcols1",
        "libsqlite3-0",
        "libuuid1",
        "login",
        "mount",
        "ncurses-base",
        "ncurses-bin",
        "perl-base",
        "util-linux",
    ):
        _require(f"      {package} \\" in interceptor_contents, f"interceptor must remove unused package {package}")
    _require("_sqlite3*.so" in interceptor_contents, "interceptor must remove the unused CPython SQLite extension")
    _require(
        "COPY --from=privilege-tool-source /out/bin/setpriv /usr/local/bin/setpriv" in interceptor_contents,
        "interceptor must copy only the reviewed privilege-drop binary into the runtime",
    )
    runtime_section = interceptor_contents.split("FROM ${PYTHON_IMAGE} AS runtime", 1)[1]
    _require("apt-get install --yes --no-install-recommends ca-certificates nftables util-linux" not in runtime_section, "interceptor runtime must not install the complete util-linux package set")

    dialer_contents = dialer_dockerfile.read_text(encoding="utf-8")
    _require(
        "COPY --from=privilege-tool-source /out/bin/setpriv /usr/local/bin/setpriv" in dialer_contents,
        "dialer must copy only the reviewed privilege-drop binary into the runtime",
    )
    _require("python3-minimal" not in dialer_contents, "dialer must use the exact shared Python runtime")

    interceptor_bootstrap = (DEPLOY_ROOT / "firewall/interceptor-bootstrap.nft").read_text(encoding="utf-8")
    _require("policy drop" in interceptor_bootstrap, "interceptor bootstrap is not default-drop")
    _require("fdaa::3" in interceptor_bootstrap, "interceptor bootstrap lacks exact Fly DNS")
    _require("tcp dport 9443" in interceptor_bootstrap, "interceptor bootstrap lacks private dialer port")
    _require("dport 443 accept" not in interceptor_bootstrap, "interceptor has direct public HTTPS egress")

    dialer_bootstrap = (DEPLOY_ROOT / "firewall/dialer-bootstrap.nft").read_text(encoding="utf-8")
    _require(dialer_bootstrap.count("policy drop") == 2, "dialer bootstrap must drop input and output")
    _require("dport" not in dialer_bootstrap, "dialer bootstrap permits network ports before validation")

    for script_name, bootstrap_name in (
        ("interceptor-entrypoint.sh", "interceptor-bootstrap.nft"),
        ("dialer-entrypoint.sh", "dialer-bootstrap.nft"),
    ):
        script = (DEPLOY_ROOT / "scripts" / script_name).read_text(encoding="utf-8")
        _require(script.index(bootstrap_name) < script.index("runtime_guard.py"), f"{script_name} validates before default-drop firewall")
        _require(script.index("runtime_guard.py") < script.rindex("setpriv"), f"{script_name} drops privileges before validation")
        for required_flag in ("--no-new-privs", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all"):
            _require(required_flag in script, f"{script_name} lacks {required_flag}")


def verify_all(
    *,
    require_rendered: bool = False,
    interceptor_config: Path | None = None,
    dialer_config: Path | None = None,
) -> None:
    verify_fly_configs(
        interceptor_config or DEPLOY_ROOT / "fly-interceptor.toml",
        dialer_config or DEPLOY_ROOT / "fly-dialer.toml",
        require_rendered=require_rendered,
    )
    verify_files()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify Fly gateway deployment scaffolding without network access")
    parser.add_argument(
        "--require-rendered",
        action="store_true",
        help="also reject the committed non-deploying app-name placeholders",
    )
    parser.add_argument(
        "--interceptor-config",
        type=Path,
        default=DEPLOY_ROOT / "fly-interceptor.toml",
    )
    parser.add_argument(
        "--dialer-config",
        type=Path,
        default=DEPLOY_ROOT / "fly-dialer.toml",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        verify_all(
            require_rendered=arguments.require_rendered,
            interceptor_config=arguments.interceptor_config,
            dialer_config=arguments.dialer_config,
        )
    except VerificationError as error:
        print(f"deployment scaffold verification failed: {error}", file=sys.stderr)
        return 1
    print("deployment scaffold verification passed (static only; no Fly runtime was contacted)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
