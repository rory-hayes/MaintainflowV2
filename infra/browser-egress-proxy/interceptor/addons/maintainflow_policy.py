"""Fail-closed protocol policy for Maintain Flow's Browserbase interceptor.

This addon is deliberately narrow. It authenticates the outer Browserbase
proxy connection, permits only TLS-intercepted HTTPS, rejects protocol upgrade
escape paths, and emits a fixed privacy-safe audit schema. Destination DNS and
address approval belong to the independent Go policy dialer.

Normal mitmproxy flow logging must remain disabled by the launch wrapper. The
addon writes audit records only to a pre-opened dedicated file descriptor.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import os
import re
import stat
import time
import uuid
import weakref
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import IO, Callable, Mapping, MutableMapping, Protocol
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.x509.oid import ExtendedKeyUsageOID
from mitmproxy import ctx, exceptions, http


MAX_HEADER_BYTES = 64 * 1024
MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BODY_BYTES = 20 * 1024 * 1024
REQUIRED_TCP_TIMEOUT_SECONDS = 30
MAX_MTLS_FILE_BYTES = 1024 * 1024
MAX_PROXY_CREDENTIAL_BYTES = 1024
MAX_PROXY_CREDENTIAL_LIFETIME_SECONDS = 15 * 60
MAX_PROXY_CREDENTIAL_CLOCK_SKEW_SECONDS = 30
MAX_PROXY_SIDE_EFFECT_HOSTS = 20
MAX_JSON_SAFE_INTEGER = (1 << 53) - 1

_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_PROXY_SUBJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_SAFE_PROXY_KEY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
_SAFE_PROXY_USERNAME = re.compile(r"^mf1\.([A-Za-z0-9][A-Za-z0-9_-]{0,31})$")
_SAFE_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f]")
_ALLOWED_METHODS = frozenset(
    {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"}
)
_SIDE_EFFECT_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_AUDIT_FIELDS = frozenset(
    {
        "timestamp",
        "gateway_event_id",
        "policy_version",
        "image_digest",
        "host_hmac",
        "address_class",
        "method_class",
        "decision",
        "reason_code",
        "latency_ms",
        "request_bytes",
        "response_bytes",
    }
)


class AuditWriter(Protocol):
    def __call__(self, event: Mapping[str, object]) -> None: ...


@dataclass(frozen=True)
class ProxyCredentialClaims:
    subject: str
    expires_at: int
    side_effect_hosts: frozenset[str]


@dataclass(frozen=True)
class AuthenticatedDestination:
    hostname: str
    credential: ProxyCredentialClaims


@dataclass(frozen=True)
class PolicyConfig:
    proxy_audience: str
    proxy_verify_keys: Mapping[str, Ed25519PublicKey]
    audit_hmac_key: bytes
    policy_version: str
    image_digest: str
    dialer_proxy_url: str
    dialer_server_name: str
    dialer_client_cert_dir: str
    dialer_server_ca_file: str
    dialer_client_spiffe_id: str
    audit_fd: int | None = None

    @classmethod
    def from_environ(cls, env: Mapping[str, str] = os.environ) -> "PolicyConfig":
        required = {
            "MF_PROXY_AUDIENCE": env.get("MF_PROXY_AUDIENCE", "").strip(),
            "MF_PROXY_VERIFY_KEYS_JSON": env.get(
                "MF_PROXY_VERIFY_KEYS_JSON", ""
            ).strip(),
            "MF_AUDIT_HMAC_KEY": env.get("MF_AUDIT_HMAC_KEY", ""),
            "MF_POLICY_VERSION": env.get("MF_POLICY_VERSION", "").strip(),
            "MF_IMAGE_DIGEST": env.get("MF_IMAGE_DIGEST", "").strip(),
            "MF_DIALER_PROXY_URL": env.get("MF_DIALER_PROXY_URL", "").strip(),
            "MF_DIALER_SERVER_NAME": env.get("MF_DIALER_SERVER_NAME", "").strip(),
            "MF_DIALER_CLIENT_CERT_DIR": env.get(
                "MF_DIALER_CLIENT_CERT_DIR", ""
            ).strip(),
            "MF_DIALER_SERVER_CA_FILE": env.get("MF_DIALER_SERVER_CA_FILE", "").strip(),
            "MF_DIALER_CLIENT_SPIFFE_ID": env.get(
                "MF_DIALER_CLIENT_SPIFFE_ID", ""
            ).strip(),
            "MF_AUDIT_FD": env.get("MF_AUDIT_FD", "").strip(),
        }
        missing = sorted(key for key, value in required.items() if not value)
        if missing:
            raise ValueError(
                f"Missing mandatory interceptor configuration: {', '.join(missing)}"
            )

        proxy_audience = required["MF_PROXY_AUDIENCE"]
        proxy_verify_keys = _parse_proxy_verify_keys(
            required["MF_PROXY_VERIFY_KEYS_JSON"]
        )
        audit_key = required["MF_AUDIT_HMAC_KEY"].encode("utf-8")
        policy_version = required["MF_POLICY_VERSION"]
        image_digest = required["MF_IMAGE_DIGEST"]
        dialer_proxy_url = required["MF_DIALER_PROXY_URL"]
        dialer_server_name = required["MF_DIALER_SERVER_NAME"]
        dialer_client_cert_dir = required["MF_DIALER_CLIENT_CERT_DIR"]
        dialer_server_ca_file = required["MF_DIALER_SERVER_CA_FILE"]
        dialer_client_spiffe_id = required["MF_DIALER_CLIENT_SPIFFE_ID"]

        if not _SAFE_TOKEN.fullmatch(proxy_audience):
            raise ValueError("MF_PROXY_AUDIENCE is not structurally safe.")
        if len(audit_key) < 32 or len(audit_key) > 1024:
            raise ValueError(
                "MF_AUDIT_HMAC_KEY must contain between 32 and 1024 UTF-8 bytes."
            )
        if not _SAFE_TOKEN.fullmatch(policy_version):
            raise ValueError("MF_POLICY_VERSION is not structurally safe.")
        if not _DIGEST.fullmatch(image_digest):
            raise ValueError("MF_IMAGE_DIGEST must be one lower-case sha256 digest.")
        _validate_dialer_proxy_url(dialer_proxy_url, dialer_server_name)

        try:
            audit_fd = int(required["MF_AUDIT_FD"], 10)
        except ValueError as error:
            raise ValueError(
                "MF_AUDIT_FD must be an integer file descriptor."
            ) from error
        if audit_fd < 3:
            raise ValueError(
                "MF_AUDIT_FD must be a dedicated descriptor greater than stderr."
            )

        configuration = cls(
            proxy_audience=proxy_audience,
            proxy_verify_keys=proxy_verify_keys,
            audit_hmac_key=audit_key,
            policy_version=policy_version,
            image_digest=image_digest,
            dialer_proxy_url=dialer_proxy_url,
            dialer_server_name=dialer_server_name,
            dialer_client_cert_dir=dialer_client_cert_dir,
            dialer_server_ca_file=dialer_server_ca_file,
            dialer_client_spiffe_id=dialer_client_spiffe_id,
            audit_fd=audit_fd,
        )
        validate_internal_mtls(configuration)
        return configuration


def _parse_proxy_verify_keys(value: str) -> Mapping[str, Ed25519PublicKey]:
    try:
        decoded = json.loads(value)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise ValueError(
            "MF_PROXY_VERIFY_KEYS_JSON must be a JSON object of key IDs to base64 SPKI Ed25519 public keys."
        ) from error
    if not isinstance(decoded, dict) or not 1 <= len(decoded) <= 4:
        raise ValueError(
            "MF_PROXY_VERIFY_KEYS_JSON must contain between one and four trusted keys."
        )

    result: dict[str, Ed25519PublicKey] = {}
    for key_id, encoded_key in decoded.items():
        if (
            not isinstance(key_id, str)
            or not _SAFE_PROXY_KEY_ID.fullmatch(key_id)
            or not isinstance(encoded_key, str)
            or not encoded_key
        ):
            raise ValueError("MF_PROXY_VERIFY_KEYS_JSON contains an invalid key entry.")
        try:
            der = base64.b64decode(encoded_key, validate=True)
            public_key = serialization.load_der_public_key(der)
        except (binascii.Error, TypeError, ValueError) as error:
            raise ValueError(
                "MF_PROXY_VERIFY_KEYS_JSON keys must be base64-encoded SPKI Ed25519 public keys."
            ) from error
        if not isinstance(public_key, Ed25519PublicKey):
            raise ValueError("MF_PROXY_VERIFY_KEYS_JSON keys must use Ed25519.")
        result[key_id] = public_key
    return MappingProxyType(result)


def _validate_dialer_proxy_url(value: str, expected_hostname: str) -> None:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.port != 9443:
        raise ValueError("MF_DIALER_PROXY_URL must be an HTTPS origin on port 9443.")
    if (
        parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "MF_DIALER_PROXY_URL must not contain credentials, path, query, or fragment."
        )
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        pass
    else:
        raise ValueError(
            "MF_DIALER_PROXY_URL must use the reviewed private DNS name, not an IP literal."
        )
    hostname = parsed.hostname.lower().rstrip(".")
    if not hostname.isascii() or not expected_hostname.isascii():
        raise ValueError("The dialer server name must contain ASCII DNS labels only.")
    expected_hostname = expected_hostname.lower()
    if expected_hostname.endswith(".") or hostname != expected_hostname:
        raise ValueError(
            "MF_DIALER_PROXY_URL must use the exact MF_DIALER_SERVER_NAME."
        )
    if not (hostname.endswith(".internal") or hostname.endswith(".flycast")):
        raise ValueError("MF_DIALER_PROXY_URL must use a Fly private DNS name.")
    if any(not _HOST_LABEL.fullmatch(label) for label in hostname.split(".")):
        raise ValueError("MF_DIALER_SERVER_NAME is not a canonical DNS hostname.")


def _read_bounded_regular_file(path: Path, description: str) -> bytes:
    try:
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError
        if metadata.st_size <= 0 or metadata.st_size > MAX_MTLS_FILE_BYTES:
            raise ValueError
        return path.read_bytes()
    except (OSError, ValueError) as error:
        raise ValueError(
            f"The {description} is missing, empty, oversized, or not a regular file."
        ) from error


def _certificate_is_current(certificate: x509.Certificate) -> bool:
    now = datetime.now(timezone.utc)
    return certificate.not_valid_before_utc <= now < certificate.not_valid_after_utc


def validate_internal_mtls(configuration: PolicyConfig) -> None:
    """Validate the exact per-SNI client identity and private server trust root."""
    cert_directory = Path(configuration.dialer_client_cert_dir)
    ca_file = Path(configuration.dialer_server_ca_file)
    if not cert_directory.is_absolute() or not ca_file.is_absolute():
        raise ValueError("Internal mTLS paths must be absolute.")
    try:
        entries = list(cert_directory.iterdir())
    except OSError as error:
        raise ValueError(
            "The internal mTLS client certificate directory is missing."
        ) from error

    client_identity_file = cert_directory / f"{configuration.dialer_server_name}.pem"
    if entries != [client_identity_file]:
        raise ValueError(
            "The internal mTLS client certificate directory must contain only the exact dialer SNI PEM."
        )
    try:
        mode = stat.S_IMODE(client_identity_file.stat().st_mode)
    except OSError as error:
        raise ValueError("The internal mTLS client identity is missing.") from error
    if mode & 0o077 or not mode & stat.S_IRUSR:
        raise ValueError(
            "The internal mTLS client identity must be owner-readable and inaccessible to group and other users."
        )

    identity_pem = _read_bounded_regular_file(
        client_identity_file, "internal mTLS client identity"
    )
    ca_pem = _read_bounded_regular_file(ca_file, "internal mTLS server CA bundle")
    if b"PRIVATE KEY" in ca_pem:
        raise ValueError(
            "The internal mTLS server CA bundle must not contain a private key."
        )

    try:
        identity_certificates = x509.load_pem_x509_certificates(identity_pem)
        private_key = serialization.load_pem_private_key(identity_pem, password=None)
        server_ca_certificates = x509.load_pem_x509_certificates(ca_pem)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "Internal mTLS material is not valid unencrypted PEM."
        ) from error
    if not identity_certificates or not server_ca_certificates:
        raise ValueError("Internal mTLS certificate chains cannot be empty.")

    leaf = identity_certificates[0]
    if not _certificate_is_current(leaf):
        raise ValueError("The internal mTLS client certificate is not currently valid.")
    try:
        usages = leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    except x509.ExtensionNotFound:
        usages = None
    if usages is not None and (
        ExtendedKeyUsageOID.CLIENT_AUTH not in usages
        and ExtendedKeyUsageOID.ANY_EXTENDED_KEY_USAGE not in usages
    ):
        raise ValueError(
            "The internal mTLS certificate does not permit client authentication."
        )
    try:
        uris = leaf.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value.get_values_for_type(x509.UniformResourceIdentifier)
    except x509.ExtensionNotFound:
        uris = []
    if uris != [configuration.dialer_client_spiffe_id]:
        raise ValueError("The internal mTLS client SPIFFE identity is not exact.")
    parsed_spiffe = urlsplit(configuration.dialer_client_spiffe_id)
    if (
        parsed_spiffe.scheme != "spiffe"
        or not parsed_spiffe.hostname
        or parsed_spiffe.username
        or parsed_spiffe.password
        or parsed_spiffe.query
        or parsed_spiffe.fragment
    ):
        raise ValueError("MF_DIALER_CLIENT_SPIFFE_ID must be one canonical SPIFFE URI.")

    leaf_public_key = leaf.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    private_public_key = private_key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    if not hmac.compare_digest(leaf_public_key, private_public_key):
        raise ValueError("The internal mTLS client certificate and key do not match.")

    for certificate in server_ca_certificates:
        try:
            basic_constraints = certificate.extensions.get_extension_for_class(
                x509.BasicConstraints
            ).value
        except x509.ExtensionNotFound as error:
            raise ValueError(
                "The internal mTLS server trust bundle contains a non-CA certificate."
            ) from error
        if not basic_constraints.ca or not _certificate_is_current(certificate):
            raise ValueError(
                "The internal mTLS server trust bundle contains an invalid CA."
            )


class FileDescriptorAuditWriter:
    """Writes one allowlisted JSON event per line to a dedicated inherited FD."""

    def __init__(self, fd: int):
        self._stream: IO[str] = os.fdopen(
            os.dup(fd), "w", encoding="utf-8", buffering=1
        )

    def __call__(self, event: Mapping[str, object]) -> None:
        if frozenset(event) != _AUDIT_FIELDS:
            raise RuntimeError("Audit event schema mismatch.")
        encoded = json.dumps(
            event, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        self._stream.write(encoded + "\n")
        self._stream.flush()


def normalize_hostname(raw_hostname: str) -> str:
    """Return a conservative ASCII DNS hostname or raise ValueError.

    The Go dialer repeats stricter UTS #46 normalization and owns the final DNS
    decision. This check prevents obviously ambiguous authorities from reaching
    the TLS interception path.
    """

    if (
        not raw_hostname
        or not raw_hostname.isascii()
        or _CONTROL_OR_SPACE.search(raw_hostname)
    ):
        raise ValueError("invalid_hostname")
    if any(character in raw_hostname for character in "@/%\\?#[]"):
        raise ValueError("invalid_hostname")
    if raw_hostname.endswith(".."):
        raise ValueError("invalid_hostname")

    hostname = raw_hostname[:-1] if raw_hostname.endswith(".") else raw_hostname
    ascii_hostname = hostname.lower()

    if len(ascii_hostname) > 253 or "." not in ascii_hostname:
        raise ValueError("invalid_hostname")
    labels = ascii_hostname.split(".")
    if any(not _HOST_LABEL.fullmatch(label) for label in labels):
        raise ValueError("invalid_hostname")
    if (
        labels[-1].isdigit()
        or ascii_hostname == "localhost"
        or ascii_hostname.endswith(".localhost")
    ):
        raise ValueError("invalid_hostname")
    try:
        ipaddress.ip_address(ascii_hostname)
    except ValueError:
        return ascii_hostname
    raise ValueError("invalid_hostname")


def normalize_connect_authority(raw_authority: str) -> str:
    if not raw_authority or raw_authority.count(":") != 1:
        raise ValueError("invalid_authority")
    raw_hostname, raw_port = raw_authority.rsplit(":", 1)
    if raw_port != "443":
        raise ValueError("connect_port_forbidden")
    return normalize_hostname(raw_hostname)


def header_size(headers: http.Headers) -> int:
    return sum(len(name) + len(value) + 4 for name, value in headers.fields) + 2


def method_class(method: str) -> str:
    upper = method.upper()
    if upper == "CONNECT":
        return "connect"
    if upper in {"GET", "HEAD", "OPTIONS"}:
        return "read"
    if upper in _SIDE_EFFECT_METHODS:
        return "side_effect"
    return "unsupported"


def verify_proxy_credential(
    username: str,
    password: str,
    *,
    audience: str,
    verify_keys: Mapping[str, Ed25519PublicKey],
    now: int,
) -> ProxyCredentialClaims | None:
    """Verify one compact, short-lived, destination-scoped proxy credential.

    The signed password is intentionally not a general JWT. Its exact claim
    shape and Ed25519 key set are owned by Maintain Flow, and neither the token
    nor its jti is written to logs or durable gateway state.
    """

    username_match = _SAFE_PROXY_USERNAME.fullmatch(username)
    if not username_match or not isinstance(password, str):
        return None
    try:
        password_bytes = password.encode("ascii", "strict")
    except UnicodeError:
        return None
    if not 1 <= len(password_bytes) <= MAX_PROXY_CREDENTIAL_BYTES:
        return None
    parts = password.split(".")
    if len(parts) != 2:
        return None
    encoded_claims, encoded_signature = parts
    try:
        claims_bytes = _decode_canonical_base64url(encoded_claims)
        signature = _decode_canonical_base64url(encoded_signature)
    except ValueError:
        return None
    if len(signature) != 64:
        return None

    public_key = verify_keys.get(username_match.group(1))
    if public_key is None:
        return None
    try:
        public_key.verify(signature, encoded_claims.encode("ascii"))
    except (InvalidSignature, ValueError):
        return None

    try:
        claims = json.loads(
            claims_bytes.decode("utf-8", "strict"),
            object_pairs_hook=_reject_duplicate_json_keys,
        )
    except (DuplicateJsonKeyError, json.JSONDecodeError, UnicodeError):
        return None
    if not isinstance(claims, dict) or set(claims) != {
        "v",
        "iss",
        "aud",
        "sub",
        "jti",
        "iat",
        "nbf",
        "exp",
        "seh",
    }:
        return None

    issued_at = claims.get("iat")
    not_before = claims.get("nbf")
    expires_at = claims.get("exp")
    subject = claims.get("sub")
    jti = claims.get("jti")
    side_effect_hosts = claims.get("seh")
    if (
        claims.get("v") != 1
        or claims.get("iss") != "maintainflow"
        or claims.get("aud") != audience
        or not isinstance(subject, str)
        or not _SAFE_PROXY_SUBJECT.fullmatch(subject)
        or not isinstance(jti, str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{22}", jti)
        or type(issued_at) is not int
        or type(not_before) is not int
        or type(expires_at) is not int
        or any(
            abs(value) > MAX_JSON_SAFE_INTEGER
            for value in (issued_at, not_before, expires_at)
        )
        or expires_at <= issued_at
        or expires_at - issued_at > MAX_PROXY_CREDENTIAL_LIFETIME_SECONDS
        or not_before > issued_at
        or issued_at - not_before > MAX_PROXY_CREDENTIAL_CLOCK_SKEW_SECONDS
        or issued_at > now + MAX_PROXY_CREDENTIAL_CLOCK_SKEW_SECONDS
        or now < not_before
        or now >= expires_at
        or not isinstance(side_effect_hosts, list)
        or len(side_effect_hosts) > MAX_PROXY_SIDE_EFFECT_HOSTS
    ):
        return None

    canonical_hosts: list[str] = []
    try:
        for host in side_effect_hosts:
            if not isinstance(host, str):
                return None
            canonical_hosts.append(normalize_hostname(host))
    except ValueError:
        return None
    if canonical_hosts != sorted(set(canonical_hosts)) or canonical_hosts != side_effect_hosts:
        return None
    return ProxyCredentialClaims(
        subject=subject,
        expires_at=expires_at,
        side_effect_hosts=frozenset(canonical_hosts),
    )


class DuplicateJsonKeyError(ValueError):
    pass


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKeyError
        result[key] = value
    return result


def _decode_canonical_base64url(value: str) -> bytes:
    if not value or not _SAFE_BASE64URL.fullmatch(value) or len(value) % 4 == 1:
        raise ValueError("invalid_base64url")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError) as error:
        raise ValueError("invalid_base64url") from error
    canonical = base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(canonical, value):
        raise ValueError("invalid_base64url")
    return decoded


def validate_runtime_options(options: object, configuration: PolicyConfig) -> list[str]:
    expected_mode = [f"upstream:{configuration.dialer_proxy_url}"]
    checks = {
        "mode": getattr(options, "mode", None) == expected_mode,
        "ssl_insecure": getattr(options, "ssl_insecure", None) is False,
        "client_certs": getattr(options, "client_certs", None)
        == configuration.dialer_client_cert_dir,
        "ssl_verify_upstream_trusted_ca": getattr(
            options, "ssl_verify_upstream_trusted_ca", None
        )
        == configuration.dialer_server_ca_file,
        "ssl_verify_upstream_trusted_confdir": not getattr(
            options, "ssl_verify_upstream_trusted_confdir", None
        ),
        "tls_version_server_min": getattr(options, "tls_version_server_min", None)
        == "TLS1_2",
        "http_connect_send_host_header": getattr(
            options, "http_connect_send_host_header", None
        )
        is True,
        "upstream_auth": not getattr(options, "upstream_auth", None),
        "upstream_cert": getattr(options, "upstream_cert", None) is True,
        "rawtcp": getattr(options, "rawtcp", None) is False,
        "websocket": getattr(options, "websocket", None) is False,
        "http2": getattr(options, "http2", None) is True,
        "http3": getattr(options, "http3", None) is False,
        "connection_strategy": getattr(options, "connection_strategy", None) == "lazy",
        "body_size_limit": getattr(options, "body_size_limit", None) == "20m",
        "stream_large_bodies": str(getattr(options, "stream_large_bodies", "")) == "1",
        "store_streamed_bodies": getattr(options, "store_streamed_bodies", None)
        is False,
        "validate_inbound_headers": getattr(options, "validate_inbound_headers", None)
        is True,
        "tcp_timeout": getattr(options, "tcp_timeout", None)
        == REQUIRED_TCP_TIMEOUT_SECONDS,
        "block_global": getattr(options, "block_global", None) is False,
        "flow_detail": getattr(options, "flow_detail", None) == 0,
        "termlog_verbosity": getattr(options, "termlog_verbosity", None) == "error",
        "showhost": getattr(options, "showhost", None) is False,
        "ignore_hosts": not getattr(options, "ignore_hosts", None),
        "tcp_hosts": not getattr(options, "tcp_hosts", None),
        "udp_hosts": not getattr(options, "udp_hosts", None),
    }
    return [name for name, passed in checks.items() if not passed]


def verify_patched_parser() -> None:
    """Refuse to start unless the reviewed pre-parse limits are loaded.

    Keeping the patch and its verifier in the repository is insufficient: the
    running interpreter must import the patched modules. These sentinel values
    are added by our reviewed source patch and do not exist in the upstream
    PyPI wheel.
    """

    from h11 import _readers as h11_readers
    from mitmproxy.proxy.layers import http as http_layer
    from mitmproxy.proxy.layers.http import _http1, _http_h2

    if getattr(_http1, "MAX_HTTP1_HEADER_BYTES", None) != MAX_HEADER_BYTES:
        raise ValueError("The reviewed HTTP/1 pre-parse header limit is not loaded.")
    if getattr(_http_h2, "MAX_HTTP2_HEADER_LIST_BYTES", None) != MAX_HEADER_BYTES:
        raise ValueError("The reviewed HTTP/2 decompressed header limit is not loaded.")
    if (
        getattr(http_layer, "MAINTAINFLOW_STREAM_LIMITS_PATCHED", None) is not True
        or getattr(http_layer, "MAINTAINFLOW_MAX_REQUEST_BODY_BYTES", None)
        != MAX_REQUEST_BODY_BYTES
        or getattr(http_layer, "MAINTAINFLOW_MAX_RESPONSE_BODY_BYTES", None)
        != MAX_RESPONSE_BODY_BYTES
    ):
        raise ValueError("The reviewed cumulative stream body limits are not loaded.")
    if (
        getattr(h11_readers, "MAINTAINFLOW_MAX_CHUNK_HEADER_BYTES", None)
        != MAX_HEADER_BYTES
        or getattr(h11_readers, "MAINTAINFLOW_MAX_CHUNK_TRAILER_BYTES", None)
        != MAX_HEADER_BYTES
    ):
        raise ValueError("The reviewed h11 chunk framing limits are not loaded.")


class MaintainFlowPolicy:
    def __init__(
        self,
        config: PolicyConfig | None = None,
        audit_writer: AuditWriter | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        self._config = config
        self._audit_writer = audit_writer
        self._clock = clock
        self._wall_clock = wall_clock
        self._authenticated_destinations: MutableMapping[
            object, AuthenticatedDestination
        ] = (
            weakref.WeakKeyDictionary()
        )
        self._ready = config is not None and audit_writer is not None

    def running(self) -> None:
        try:
            if self._config is None:
                self._config = PolicyConfig.from_environ()
            if self._audit_writer is None:
                assert self._config.audit_fd is not None
                self._audit_writer = FileDescriptorAuditWriter(self._config.audit_fd)
            validate_internal_mtls(self._config)
            verify_patched_parser()
            invalid_options = validate_runtime_options(ctx.options, self._config)
            if invalid_options:
                raise ValueError(
                    f"Unsafe mitmproxy options: {', '.join(sorted(invalid_options))}"
                )
        except (OSError, ValueError) as error:
            raise exceptions.OptionsError(
                "Maintain Flow interceptor failed closed during startup."
            ) from error
        self._ready = True

    def client_disconnected(self, client: object) -> None:
        self._authenticated_destinations.pop(client, None)

    def http_connect(self, flow: http.HTTPFlow) -> None:
        started = self._clock()
        if not self._ensure_ready(flow):
            return
        assert self._config is not None

        # A CONNECT consumes one HTTP/1.1 client connection as one authenticated
        # tunnel. HTTP/2 would multiplex independent CONNECT streams on the same
        # ``client_conn`` and make connection-scoped credentials ambiguous.
        # Clear any prior state before every re-authentication attempt and refuse
        # multiplexed CONNECT even if an edge ALPN policy is misconfigured.
        self._authenticated_destinations.pop(flow.client_conn, None)
        auth_header = flow.request.headers.pop("Proxy-Authorization", "")
        if flow.request.http_version != "HTTP/1.1":
            self._deny(
                flow,
                403,
                "connect_http_version_forbidden",
                "invalid-authority",
                "connect",
                started,
            )
            return
        credential = self._authenticate(auth_header)
        if credential is None:
            self._deny(
                flow,
                407,
                "proxy_auth_failed",
                "invalid-authority",
                "connect",
                started,
                proxy_auth=True,
            )
            return

        raw_authority = flow.request.authority
        try:
            hostname = normalize_connect_authority(raw_authority)
        except ValueError as error:
            reason = (
                str(error)
                if str(error) in {"invalid_authority", "connect_port_forbidden"}
                else "invalid_authority"
            )
            self._deny(flow, 403, reason, "invalid-authority", "connect", started)
            return

        flow.request.host = hostname
        flow.request.port = 443
        flow.request.authority = f"{hostname}:443"
        self._authenticated_destinations[flow.client_conn] = AuthenticatedDestination(
            hostname=hostname, credential=credential
        )
        if not self._audit(
            hostname, "connect", "allowed", "connect_allowed", started, 0, 0
        ):
            self._authenticated_destinations.pop(flow.client_conn, None)
            self._set_response(flow, 503)

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        started = self._clock()
        if not self._ensure_ready(flow):
            return
        destination = self._authenticated_destinations.get(flow.client_conn)
        if destination is None:
            flow.request.headers.pop("Proxy-Authorization", None)
            self._deny(
                flow,
                407,
                "connect_auth_required",
                "invalid-authority",
                method_class(flow.request.method),
                started,
                proxy_auth=True,
            )
            return
        expected_host = destination.hostname
        if self._wall_clock() >= destination.credential.expires_at:
            self._authenticated_destinations.pop(flow.client_conn, None)
            flow.request.headers.pop("Proxy-Authorization", None)
            self._deny(
                flow,
                407,
                "proxy_credential_expired",
                expected_host,
                method_class(flow.request.method),
                started,
                proxy_auth=True,
            )
            return

        flow.request.headers.pop("Proxy-Authorization", None)
        try:
            request_host = normalize_hostname(flow.request.host)
        except ValueError:
            self._deny(
                flow,
                403,
                "invalid_inner_host",
                expected_host,
                method_class(flow.request.method),
                started,
            )
            return

        request_method = flow.request.method.upper()
        if flow.request.scheme != "https" or flow.request.port != 443:
            self._deny(
                flow,
                403,
                "non_https_forbidden",
                expected_host,
                method_class(request_method),
                started,
            )
            return
        if request_host != expected_host:
            self._deny(
                flow,
                403,
                "authority_mismatch",
                expected_host,
                method_class(request_method),
                started,
            )
            return
        if request_method not in _ALLOWED_METHODS:
            reason = (
                "extended_connect_forbidden"
                if request_method == "CONNECT"
                else "method_forbidden"
            )
            self._deny(
                flow, 403, reason, expected_host, method_class(request_method), started
            )
            return
        if (
            request_method in _SIDE_EFFECT_METHODS
            and expected_host not in destination.credential.side_effect_hosts
        ):
            self._deny(
                flow,
                403,
                "side_effect_host_forbidden",
                expected_host,
                method_class(request_method),
                started,
            )
            return
        if header_size(flow.request.headers) > MAX_HEADER_BYTES:
            self._deny(
                flow,
                431,
                "request_headers_too_large",
                expected_host,
                method_class(request_method),
                started,
            )
            return
        if self._has_upgrade_signal(flow.request.headers):
            self._deny(
                flow,
                403,
                "protocol_upgrade_forbidden",
                expected_host,
                method_class(request_method),
                started,
            )
            return

        declared_length = self._content_length(flow.request.headers)
        if declared_length is None and request_method in _SIDE_EFFECT_METHODS:
            self._deny(
                flow,
                411,
                "bounded_length_required",
                expected_host,
                method_class(request_method),
                started,
            )
            return
        if declared_length is not None and declared_length > MAX_REQUEST_BODY_BYTES:
            self._deny(
                flow,
                413,
                "request_body_too_large",
                expected_host,
                method_class(request_method),
                started,
                request_bytes=declared_length,
            )
            return
        if "transfer-encoding" in flow.request.headers:
            self._deny(
                flow,
                403,
                "chunked_request_forbidden",
                expected_host,
                method_class(request_method),
                started,
            )
            return
        request_encoding = (
            flow.request.headers.get("Content-Encoding", "identity").strip().lower()
        )
        if request_encoding not in {"", "identity"}:
            self._deny(
                flow,
                403,
                "compressed_request_forbidden",
                expected_host,
                method_class(request_method),
                started,
            )
            return

        # Launch journeys do not need compressed payloads. Asking for identity
        # and rejecting any encoded response makes wire and decoded byte
        # accounting identical. The pinned 20 MiB streaming body limit can then
        # abort safely without exposing the interceptor to a compression bomb.
        flow.request.headers["Accept-Encoding"] = "identity"
        flow.request.headers.pop("TE", None)

        if not self._audit(
            expected_host,
            method_class(request_method),
            "allowed",
            "request_allowed",
            started,
            declared_length or 0,
            0,
        ):
            self._set_response(flow, 503)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        started = self._clock()
        if not self._ensure_ready(flow):
            return
        destination = self._authenticated_destinations.get(flow.client_conn)
        expected_host = destination.hostname if destination else "invalid-authority"
        response = flow.response
        if response is None:
            self._deny(
                flow,
                502,
                "missing_response",
                expected_host,
                method_class(flow.request.method),
                started,
            )
            return

        response.headers.pop("Alt-Svc", None)
        response.headers.pop("Proxy-Authenticate", None)
        if response.status_code == 101 or self._has_upgrade_signal(response.headers):
            self._deny(
                flow,
                502,
                "upstream_upgrade_forbidden",
                expected_host,
                method_class(flow.request.method),
                started,
            )
            return
        if header_size(response.headers) > MAX_HEADER_BYTES:
            self._deny(
                flow,
                502,
                "response_headers_too_large",
                expected_host,
                method_class(flow.request.method),
                started,
            )
            return
        transfer_encodings = [
            value.strip().lower()
            for value in response.headers.get_all("Transfer-Encoding")
        ]
        if transfer_encodings and transfer_encodings not in [["identity"], ["chunked"]]:
            self._deny(
                flow,
                502,
                "response_transfer_encoding_forbidden",
                expected_host,
                method_class(flow.request.method),
                started,
            )
            return
        response_encoding = (
            response.headers.get("Content-Encoding", "identity").strip().lower()
        )
        if response_encoding not in {"", "identity"}:
            self._deny(
                flow,
                502,
                "compressed_response_forbidden",
                expected_host,
                method_class(flow.request.method),
                started,
            )
            return
        declared_length = self._content_length(response.headers)
        if declared_length is not None and declared_length > MAX_RESPONSE_BODY_BYTES:
            self._deny(
                flow,
                502,
                "response_body_too_large",
                expected_host,
                method_class(flow.request.method),
                started,
                response_bytes=declared_length,
            )

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        self._kill_non_http(flow, "websocket_backstop")

    def tcp_start(self, flow: object) -> None:
        self._kill_non_http(flow, "raw_tcp_forbidden")

    def udp_start(self, flow: object) -> None:
        self._kill_non_http(flow, "raw_udp_forbidden")

    def _kill_non_http(self, flow: object, reason_code: str) -> None:
        if hasattr(flow, "kill"):
            flow.kill()
        if self._ready:
            self._audit(
                "invalid-authority",
                "unsupported",
                "blocked",
                reason_code,
                self._clock(),
                0,
                0,
            )

    def _ensure_ready(self, flow: http.HTTPFlow) -> bool:
        if self._ready:
            return True
        self._set_response(flow, 503)
        return False

    def _authenticate(self, value: str) -> ProxyCredentialClaims | None:
        assert self._config is not None
        try:
            scheme, encoded = value.split(" ", 1)
            if scheme.lower() != "basic":
                return None
            decoded = base64.b64decode(encoded, validate=True).decode("utf-8", "strict")
            username, separator, password = decoded.partition(":")
            if not separator:
                return None
        except (binascii.Error, UnicodeError, ValueError):
            return None
        return verify_proxy_credential(
            username,
            password,
            audience=self._config.proxy_audience,
            verify_keys=self._config.proxy_verify_keys,
            now=int(self._wall_clock()),
        )

    @staticmethod
    def _has_upgrade_signal(headers: http.Headers) -> bool:
        connection_tokens = {
            token.strip().lower() for token in headers.get("Connection", "").split(",")
        }
        names = {name.decode("latin-1").lower() for name, _ in headers.fields}
        return bool(
            headers.get("Upgrade", "")
            or "upgrade" in connection_tokens
            or any(name.startswith("sec-websocket-") for name in names)
            or any(name.startswith("sec-webtransport-") for name in names)
            or ":protocol" in names
        )

    @staticmethod
    def _content_length(headers: http.Headers) -> int | None:
        values = headers.get_all("Content-Length")
        if not values:
            return None
        if len(set(values)) != 1 or not values[0].isdigit():
            return MAX_RESPONSE_BODY_BYTES + 1
        return int(values[0], 10)

    def _deny(
        self,
        flow: http.HTTPFlow,
        status_code: int,
        reason_code: str,
        hostname: str,
        request_method_class: str,
        started: float,
        *,
        proxy_auth: bool = False,
        request_bytes: int = 0,
        response_bytes: int = 0,
    ) -> None:
        self._audit(
            hostname,
            request_method_class,
            "blocked",
            reason_code,
            started,
            request_bytes,
            response_bytes,
        )
        self._set_response(flow, status_code, proxy_auth=proxy_auth)

    @staticmethod
    def _set_response(
        flow: http.HTTPFlow, status_code: int, *, proxy_auth: bool = False
    ) -> None:
        headers: dict[str, str] = {
            "Cache-Control": "no-store",
            "Connection": "close",
            "Content-Length": "0",
        }
        if proxy_auth:
            headers["Proxy-Authenticate"] = 'Basic realm="Maintain Flow egress"'
        flow.response = http.Response.make(status_code, b"", headers)

    def _audit(
        self,
        hostname: str,
        request_method_class: str,
        decision: str,
        reason_code: str,
        started: float,
        request_bytes: int,
        response_bytes: int,
    ) -> bool:
        assert self._config is not None
        assert self._audit_writer is not None
        safe_hostname = (
            hostname if hostname != "invalid-authority" else "invalid-authority"
        )
        event = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "gateway_event_id": uuid.uuid4().hex,
            "policy_version": self._config.policy_version,
            "image_digest": self._config.image_digest,
            "host_hmac": hmac.new(
                self._config.audit_hmac_key,
                safe_hostname.encode("ascii", "strict"),
                hashlib.sha256,
            ).hexdigest(),
            "address_class": "not_resolved",
            "method_class": request_method_class,
            "decision": decision,
            "reason_code": reason_code,
            "latency_ms": min(max(int((self._clock() - started) * 1000), 0), 30_000),
            "request_bytes": min(max(request_bytes, 0), MAX_REQUEST_BODY_BYTES + 1),
            "response_bytes": min(max(response_bytes, 0), MAX_RESPONSE_BODY_BYTES + 1),
        }
        try:
            self._audit_writer(event)
        except (OSError, RuntimeError, ValueError):
            return False
        return True
