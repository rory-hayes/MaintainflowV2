#!/usr/bin/env python3
"""Fail-closed runtime preparation for the two Fly gateway Machines.

This module deliberately uses only the Python standard library so its policy
and tests do not depend on package installation or network access. It never
prints environment values, decoded secrets, destinations, or resolver names.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import ipaddress
import json
import os
import re
import socket
import stat
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence


MAX_SECRET_BYTES = 1 << 20
MAX_PRIVATE_DIALER_ADDRESSES = 32
FLY_6PN = ipaddress.ip_network("fdaa::/16")
FLY_MACHINE_DNS = ipaddress.ip_address("fdaa::3")
EXPECTED_SPIFFE_ID = "spiffe://maintainflow/interceptor"

_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PROXY_KEY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_IANA_NAMESPACE = {"iana": "http://www.iana.org/assignments"}
_ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


class RuntimeGateError(ValueError):
    """A startup condition failed before the workload was allowed to bind."""


def _required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "")
    if not value:
        raise RuntimeGateError(f"missing mandatory runtime value: {name}")
    return value


def _bounded_text_secret(environment: Mapping[str, str], name: str) -> str:
    value = _required(environment, name)
    size = len(value.encode("utf-8"))
    if size < 32 or size > 1024:
        raise RuntimeGateError(f"{name} has an invalid length")
    return value


def _validate_digest(value: str, name: str) -> None:
    if not _DIGEST.fullmatch(value):
        raise RuntimeGateError(f"{name} must be one lower-case sha256 digest")


def _validate_dns_name(value: str, *, private: bool = False) -> str:
    if value != value.lower() or value.endswith(".") or not value.isascii():
        raise RuntimeGateError("DNS names must be lower-case canonical ASCII")
    if len(value) > 253 or "." not in value:
        raise RuntimeGateError("a multi-label DNS name is required")
    if any(not _DNS_LABEL.fullmatch(label) for label in value.split(".")):
        raise RuntimeGateError("DNS name contains an invalid label")
    if private and not value.endswith(".internal"):
        raise RuntimeGateError("the dialer must use an exact .internal name")
    if "replace-with-reviewed" in value:
        raise RuntimeGateError("deployment template placeholders must be replaced")
    return value


def _validate_spiffe(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if (
        value != EXPECTED_SPIFFE_ID
        or parsed.scheme != "spiffe"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeGateError("the exact reviewed interceptor SPIFFE URI is required")
    return value


def parse_proxy_verify_keys(value: str) -> dict[str, bytes]:
    if len(value.encode("utf-8")) > 4096:
        raise RuntimeGateError("proxy verification key set is oversized")
    try:
        decoded = json.loads(value)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise RuntimeGateError("proxy verification key set is not valid JSON") from error
    if not isinstance(decoded, dict) or not 1 <= len(decoded) <= 4:
        raise RuntimeGateError("proxy verification key set must contain one to four keys")
    result: dict[str, bytes] = {}
    for key_id, encoded_key in decoded.items():
        if not isinstance(key_id, str) or not _PROXY_KEY_ID.fullmatch(key_id):
            raise RuntimeGateError("proxy verification key ID is invalid")
        if not isinstance(encoded_key, str) or not encoded_key:
            raise RuntimeGateError("proxy verification key value is invalid")
        try:
            der = base64.b64decode(encoded_key, validate=True)
        except (binascii.Error, ValueError) as error:
            raise RuntimeGateError("proxy verification key is not strict base64") from error
        if len(der) != 44 or not der.startswith(_ED25519_SPKI_PREFIX):
            raise RuntimeGateError("proxy verification keys must be Ed25519 SPKI DER")
        result[key_id] = der
    return result


def _decode_pem_secret(
    environment: Mapping[str, str],
    name: str,
    *,
    required_markers: Sequence[bytes],
    forbidden_markers: Sequence[bytes] = (),
) -> bytes:
    encoded = "".join(_required(environment, name).split())
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RuntimeGateError(f"{name} is not strict base64") from error
    if not decoded or len(decoded) > MAX_SECRET_BYTES:
        raise RuntimeGateError(f"{name} is empty or oversized")
    if any(marker not in decoded for marker in required_markers):
        raise RuntimeGateError(f"{name} is missing required PEM material")
    if any(marker in decoded for marker in forbidden_markers):
        raise RuntimeGateError(f"{name} contains forbidden private material")
    return decoded


def _secure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=False)
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeGateError("runtime directory is not a private directory")


def _secure_write(path: Path, contents: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != mode:
        raise RuntimeGateError("runtime material was not written as a private regular file")


def resolve_dialer_addresses(hostname: str) -> tuple[ipaddress.IPv6Address, ...]:
    try:
        answers = socket.getaddrinfo(
            hostname,
            9443,
            family=socket.AF_INET6,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except socket.gaierror as error:
        raise RuntimeGateError("private dialer DNS resolution failed") from error
    addresses = {
        ipaddress.ip_address(answer[4][0].split("%", 1)[0]) for answer in answers
    }
    if not addresses or len(addresses) > MAX_PRIVATE_DIALER_ADDRESSES:
        raise RuntimeGateError("private dialer DNS returned an invalid answer count")
    for address in addresses:
        if not isinstance(address, ipaddress.IPv6Address):
            raise RuntimeGateError("private dialer DNS returned a non-IPv6 answer")
        if address not in FLY_6PN or address == FLY_MACHINE_DNS:
            raise RuntimeGateError("private dialer DNS returned a non-6PN answer")
    return tuple(sorted(addresses, key=int))


def prepare_interceptor(
    environment: Mapping[str, str],
    runtime_directory: Path,
    nft_output: Path,
    hosts_output: Path,
    *,
    resolver: Callable[[str], tuple[ipaddress.IPv6Address, ...]] = resolve_dialer_addresses,
) -> tuple[ipaddress.IPv6Address, ...]:
    hostname = _validate_dns_name(
        _required(environment, "MF_DIALER_SERVER_NAME"), private=True
    )
    expected_url = f"https://{hostname}:9443"
    if _required(environment, "MF_DIALER_PROXY_URL") != expected_url:
        raise RuntimeGateError("dialer proxy URL must match the exact private name and port")
    _validate_spiffe(_required(environment, "MF_DIALER_CLIENT_SPIFFE_ID"))

    proxy_audience = _required(environment, "MF_PROXY_AUDIENCE")
    if not _TOKEN.fullmatch(proxy_audience):
        raise RuntimeGateError("proxy audience is not structurally safe")
    parse_proxy_verify_keys(_required(environment, "MF_PROXY_VERIFY_KEYS_JSON"))
    _bounded_text_secret(environment, "MF_AUDIT_HMAC_KEY")
    if not _TOKEN.fullmatch(_required(environment, "MF_POLICY_VERSION")):
        raise RuntimeGateError("policy version is not structurally safe")
    _validate_digest(_required(environment, "MF_IMAGE_DIGEST"), "MF_IMAGE_DIGEST")

    client_identity = _decode_pem_secret(
        environment,
        "MF_DIALER_CLIENT_IDENTITY_B64",
        required_markers=(b"-----BEGIN CERTIFICATE-----", b"PRIVATE KEY-----"),
    )
    server_ca = _decode_pem_secret(
        environment,
        "MF_DIALER_SERVER_CA_B64",
        required_markers=(b"-----BEGIN CERTIFICATE-----",),
        forbidden_markers=(b"PRIVATE KEY-----",),
    )
    interception_ca = _decode_pem_secret(
        environment,
        "MF_INTERCEPTION_CA_PEM_B64",
        required_markers=(b"-----BEGIN CERTIFICATE-----", b"PRIVATE KEY-----"),
    )

    addresses = resolver(hostname)
    if not addresses:
        raise RuntimeGateError("private dialer DNS returned no approved addresses")
    for address in addresses:
        if address not in FLY_6PN or address == FLY_MACHINE_DNS:
            raise RuntimeGateError("private dialer DNS returned a non-6PN answer")

    client_directory = runtime_directory / "dialer-client"
    home_directory = runtime_directory / "home"
    mitm_directory = home_directory / ".mitmproxy"
    _secure_directory(client_directory)
    _secure_directory(home_directory)
    _secure_directory(mitm_directory)
    _secure_write(client_directory / f"{hostname}.pem", client_identity)
    _secure_write(runtime_directory / "dialer-server-ca.pem", server_ca)
    _secure_write(mitm_directory / "mitmproxy-ca.pem", interception_ca)

    address_list = ", ".join(str(address) for address in addresses)
    _secure_write(
        nft_output,
        (
            "add element inet mf_interceptor_boundary approved_dialers_v6 "
            f"{{ {address_list} }}\n"
        ).encode("ascii"),
    )
    _secure_write(
        hosts_output,
        "".join(f"{address}\t{hostname}\n" for address in addresses).encode("ascii"),
    )
    return addresses


def _parse_address_and_port(value: str) -> tuple[ipaddress._BaseAddress, int]:
    if value.startswith("["):
        closing = value.find("]")
        if closing < 0 or value[closing + 1 : closing + 2] != ":":
            raise RuntimeGateError("IPv6 resolver addresses must use [IP]:853")
        host = value[1:closing]
        port_text = value[closing + 2 :]
    else:
        if value.count(":") != 1:
            raise RuntimeGateError("resolver addresses must use IP:853")
        host, port_text = value.rsplit(":", 1)
    try:
        address = ipaddress.ip_address(host)
        port = int(port_text, 10)
    except ValueError as error:
        raise RuntimeGateError("resolver endpoint must use a numeric IP and port") from error
    if port != 853:
        raise RuntimeGateError("resolver endpoint port must be 853")
    return address, port


def parse_dot_resolvers(value: str) -> tuple[tuple[ipaddress._BaseAddress, str], ...]:
    pieces = value.split(",")
    if len(pieces) != 2 or any(piece != piece.strip() for piece in pieces):
        raise RuntimeGateError("exactly two comma-separated DoT resolvers are required")
    endpoints: list[tuple[ipaddress._BaseAddress, str]] = []
    for piece in pieces:
        if piece.count("|") != 1:
            raise RuntimeGateError("each DoT resolver requires IP:853|tls-name")
        address_port, server_name = piece.split("|", 1)
        address, _ = _parse_address_and_port(address_port)
        endpoints.append((address, _validate_dns_name(server_name)))
    if len({address for address, _ in endpoints}) != 2:
        raise RuntimeGateError("DoT resolver IPs must be distinct")
    if len({name for _, name in endpoints}) != 2:
        raise RuntimeGateError("DoT resolver TLS names must be distinct")
    return tuple(endpoints)


def load_special_networks(
    ipv4_registry: Path,
    ipv6_registry: Path,
    policy_manifest: Path | None = None,
) -> tuple[tuple[ipaddress.IPv4Network, ...], tuple[ipaddress.IPv6Network, ...]]:
    if policy_manifest is not None:
        try:
            manifest = json.loads(policy_manifest.read_text(encoding="utf-8"))
            registries = manifest["registries"]
            expected_ipv4 = registries["ipv4"]["sha256"]
            expected_ipv6 = registries["ipv6"]["sha256"]
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise RuntimeGateError("policy manifest is unreadable") from error
        for registry, expected in (
            (ipv4_registry, expected_ipv4),
            (ipv6_registry, expected_ipv6),
        ):
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                raise RuntimeGateError("policy manifest contains an invalid registry hash")
            try:
                contents = registry.read_bytes()
            except OSError as error:
                raise RuntimeGateError("IANA policy snapshot is unreadable") from error
            if not contents or len(contents) > MAX_SECRET_BYTES:
                raise RuntimeGateError("IANA policy snapshot is empty or oversized")
            if not hashlib.sha256(contents).hexdigest() == expected:
                raise RuntimeGateError("IANA policy snapshot hash mismatch")

    networks: list[ipaddress._BaseNetwork] = []
    for registry in (ipv4_registry, ipv6_registry):
        try:
            root = ET.parse(registry).getroot()
        except (ET.ParseError, OSError) as error:
            raise RuntimeGateError("IANA policy snapshot is unreadable") from error
        records = root.findall(".//iana:record", _IANA_NAMESPACE)
        if not records:
            raise RuntimeGateError("IANA policy snapshot contains no records")
        for record in records:
            raw = record.findtext("iana:address", default="", namespaces=_IANA_NAMESPACE)
            for prefix in raw.split(","):
                prefix = prefix.strip()
                if not prefix:
                    continue
                try:
                    networks.append(ipaddress.ip_network(prefix, strict=True))
                except ValueError as error:
                    raise RuntimeGateError("IANA policy snapshot contains an invalid prefix") from error

    networks.extend(
        (
            ipaddress.ip_network("224.0.0.0/4"),
            # Deprecated IPv6 site-local space is not in the current IANA
            # special registry, but must never be treated as an Internet
            # target even though some standard libraries call it unicast.
            ipaddress.ip_network("fec0::/10"),
            ipaddress.ip_network("ff00::/8"),
        )
    )
    ipv4 = tuple(
        ipaddress.collapse_addresses(
            network for network in networks if isinstance(network, ipaddress.IPv4Network)
        )
    )
    ipv6 = tuple(
        ipaddress.collapse_addresses(
            network for network in networks if isinstance(network, ipaddress.IPv6Network)
        )
    )
    if not ipv4 or not ipv6:
        raise RuntimeGateError("both IANA address families are required")
    return ipv4, ipv6


def _address_is_blocked(
    address: ipaddress._BaseAddress,
    ipv4_networks: Iterable[ipaddress.IPv4Network],
    ipv6_networks: Iterable[ipaddress.IPv6Network],
) -> bool:
    candidates: Iterable[ipaddress._BaseNetwork]
    candidates = ipv4_networks if isinstance(address, ipaddress.IPv4Address) else ipv6_networks
    return any(address in network for network in candidates)


def render_dialer_firewall(
    resolvers: Sequence[tuple[ipaddress._BaseAddress, str]],
    blocked_ipv4: Sequence[ipaddress.IPv4Network],
    blocked_ipv6: Sequence[ipaddress.IPv6Network],
) -> str:
    resolver_ipv4 = [str(address) for address, _ in resolvers if address.version == 4]
    resolver_ipv6 = [str(address) for address, _ in resolvers if address.version == 6]

    def elements(values: Sequence[object]) -> str:
        return ", ".join(str(value) for value in values)

    dot_v4_elements = (
        f"    elements = {{ {elements(resolver_ipv4)} }}\n" if resolver_ipv4 else ""
    )
    dot_v6_elements = (
        f"    elements = {{ {elements(resolver_ipv6)} }}\n" if resolver_ipv6 else ""
    )

    return f"""table inet mf_dialer_boundary {{
  set blocked_v4 {{
    type ipv4_addr
    flags interval
    auto-merge
    elements = {{ {elements(blocked_ipv4)} }}
  }}

  set blocked_v6 {{
    type ipv6_addr
    flags interval
    auto-merge
    elements = {{ {elements(blocked_ipv6)} }}
  }}

  set dot_v4 {{
    type ipv4_addr
{dot_v4_elements}  }}

  set dot_v6 {{
    type ipv6_addr
{dot_v6_elements}  }}

  chain input {{
    type filter hook input priority filter; policy drop;
    iifname "lo" accept
    ct state established,related accept
    icmpv6 type {{ 133, 134, 135, 136 }} accept
    ip6 saddr fdaa::/16 tcp dport 9443 accept
  }}

  chain output {{
    type filter hook output priority filter; policy drop;
    oifname "lo" accept
    ct state established,related accept
    icmpv6 type {{ 133, 134, 135, 136 }} accept
    ip daddr @dot_v4 tcp dport 853 accept
    ip6 daddr @dot_v6 tcp dport 853 accept
    ip daddr @blocked_v4 drop
    ip6 daddr @blocked_v6 drop
    meta nfproto ipv4 tcp dport 443 accept
    meta nfproto ipv6 tcp dport 443 accept
  }}
}}
"""


def prepare_dialer(
    environment: Mapping[str, str],
    runtime_directory: Path,
    nft_output: Path,
    ipv4_registry: Path,
    ipv6_registry: Path,
    policy_manifest: Path,
) -> tuple[tuple[ipaddress._BaseAddress, str], ...]:
    try:
        private_ip = ipaddress.ip_address(_required(environment, "FLY_PRIVATE_IP"))
    except ValueError as error:
        raise RuntimeGateError("FLY_PRIVATE_IP must be a numeric address") from error
    if not isinstance(private_ip, ipaddress.IPv6Address) or private_ip not in FLY_6PN:
        raise RuntimeGateError("dialer must bind to one exact Fly 6PN address")

    _validate_spiffe(_required(environment, "MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID"))
    _validate_digest(
        _required(environment, "MF_DIALER_IMAGE_DIGEST"),
        "MF_DIALER_IMAGE_DIGEST",
    )
    _bounded_text_secret(environment, "MF_DIALER_AUDIT_PEPPER")
    resolvers = parse_dot_resolvers(_required(environment, "MF_DIALER_DOT_RESOLVERS"))
    blocked_ipv4, blocked_ipv6 = load_special_networks(
        ipv4_registry, ipv6_registry, policy_manifest
    )
    for address, _ in resolvers:
        if not address.is_global or _address_is_blocked(
            address, blocked_ipv4, blocked_ipv6
        ):
            raise RuntimeGateError("DoT resolver IP is special-purpose or non-public")

    server_certificate = _decode_pem_secret(
        environment,
        "MF_DIALER_SERVER_CERT_B64",
        required_markers=(b"-----BEGIN CERTIFICATE-----",),
        forbidden_markers=(b"PRIVATE KEY-----",),
    )
    server_key = _decode_pem_secret(
        environment,
        "MF_DIALER_SERVER_KEY_B64",
        required_markers=(b"PRIVATE KEY-----",),
    )
    client_ca = _decode_pem_secret(
        environment,
        "MF_DIALER_CLIENT_CA_B64",
        required_markers=(b"-----BEGIN CERTIFICATE-----",),
        forbidden_markers=(b"PRIVATE KEY-----",),
    )
    _secure_write(runtime_directory / "dialer-server.pem", server_certificate)
    _secure_write(runtime_directory / "dialer-server.key", server_key)
    _secure_write(runtime_directory / "interceptor-client-ca.pem", client_ca)
    firewall = render_dialer_firewall(resolvers, blocked_ipv4, blocked_ipv6)
    _secure_write(nft_output, firewall.encode("ascii"))
    return resolvers


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Maintain Flow Fly runtime gate")
    commands = parser.add_subparsers(dest="command", required=True)

    interceptor = commands.add_parser("prepare-interceptor")
    interceptor.add_argument("--runtime-dir", type=Path, required=True)
    interceptor.add_argument("--nft-output", type=Path, required=True)
    interceptor.add_argument("--hosts-output", type=Path, required=True)

    dialer = commands.add_parser("prepare-dialer")
    dialer.add_argument("--runtime-dir", type=Path, required=True)
    dialer.add_argument("--nft-output", type=Path, required=True)
    dialer.add_argument("--ipv4-registry", type=Path, required=True)
    dialer.add_argument("--ipv6-registry", type=Path, required=True)
    dialer.add_argument("--policy-manifest", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "prepare-interceptor":
            prepare_interceptor(
                os.environ,
                arguments.runtime_dir,
                arguments.nft_output,
                arguments.hosts_output,
            )
        elif arguments.command == "prepare-dialer":
            prepare_dialer(
                os.environ,
                arguments.runtime_dir,
                arguments.nft_output,
                arguments.ipv4_registry,
                arguments.ipv6_registry,
                arguments.policy_manifest,
            )
        else:  # pragma: no cover - argparse prevents this branch.
            raise RuntimeGateError("unknown runtime guard command")
    except RuntimeGateError as error:
        print(f"runtime gate failed closed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
