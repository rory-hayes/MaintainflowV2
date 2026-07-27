from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from mitmproxy import http
from mitmproxy.connection import Client as MitmClient
from mitmproxy.options import Options
from mitmproxy.proxy.commands import SendData
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import _upstream_proxy

from addons.maintainflow_policy import (
    MAX_REQUEST_BODY_BYTES,
    MAX_RESPONSE_BODY_BYTES,
    MaintainFlowPolicy,
    PolicyConfig,
    normalize_connect_authority,
    normalize_hostname,
    validate_internal_mtls,
    validate_runtime_options,
    verify_proxy_credential,
    verify_patched_parser,
)


PROXY_PRIVATE_KEY = Ed25519PrivateKey.generate()
PROXY_PUBLIC_KEY = PROXY_PRIVATE_KEY.public_key()
PROXY_KEY_ID = "primary_2026"
PROXY_AUDIENCE = "maintainflow-browser-egress"


def proxy_verify_keys() -> dict[str, Ed25519PublicKey]:
    return {PROXY_KEY_ID: PROXY_PUBLIC_KEY}


def signed_proxy_credential(
    *,
    now: int | None = None,
    side_effect_hosts: list[str] | None = None,
    subject: str = "run:00000000-0000-4000-8000-000000000001",
) -> tuple[str, str]:
    issued_at = int(time.time()) if now is None else now
    claims = {
        "v": 1,
        "iss": "maintainflow",
        "aud": PROXY_AUDIENCE,
        "sub": subject,
        "jti": "A" * 22,
        "iat": issued_at,
        "nbf": issued_at - 30,
        "exp": issued_at + 900,
        "seh": side_effect_hosts if side_effect_hosts is not None else ["example.com"],
    }
    encoded_claims = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":")).encode()
    ).rstrip(b"=")
    signature = base64.urlsafe_b64encode(
        PROXY_PRIVATE_KEY.sign(encoded_claims)
    ).rstrip(b"=")
    return f"mf1.{PROXY_KEY_ID}", f"{encoded_claims.decode()}.{signature.decode()}"


class Client:
    pass


class Killable:
    def __init__(self) -> None:
        self.killed = False

    def kill(self) -> None:
        self.killed = True


def policy_config() -> PolicyConfig:
    return PolicyConfig(
        proxy_audience=PROXY_AUDIENCE,
        proxy_verify_keys=proxy_verify_keys(),
        audit_hmac_key=b"a" * 48,
        policy_version="browser-egress-2026-01",
        image_digest="sha256:" + "1" * 64,
        dialer_proxy_url="https://policy-dialer.internal:9443",
        dialer_server_name="policy-dialer.internal",
        dialer_client_cert_dir="/run/secrets/maintainflow-dialer-client",
        dialer_server_ca_file="/run/secrets/maintainflow-dialer-server-ca.pem",
        dialer_client_spiffe_id="spiffe://maintainflow/interceptor",
    )


def runtime_options(**overrides: object) -> SimpleNamespace:
    values = {
        "mode": ["upstream:https://policy-dialer.internal:9443"],
        "ssl_insecure": False,
        "client_certs": "/run/secrets/maintainflow-dialer-client",
        "ssl_verify_upstream_trusted_ca": "/run/secrets/maintainflow-dialer-server-ca.pem",
        "ssl_verify_upstream_trusted_confdir": None,
        "tls_version_server_min": "TLS1_2",
        "http_connect_send_host_header": True,
        "upstream_auth": None,
        "upstream_cert": True,
        "rawtcp": False,
        "websocket": False,
        "http2": True,
        "http3": False,
        "connection_strategy": "lazy",
        "body_size_limit": "20m",
        "stream_large_bodies": "1",
        "store_streamed_bodies": False,
        "validate_inbound_headers": True,
        "tcp_timeout": 30,
        "block_global": False,
        "flow_detail": 0,
        "termlog_verbosity": "error",
        "showhost": False,
        "ignore_hosts": [],
        "tcp_hosts": [],
        "udp_hosts": [],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def request_flow(
    method: str,
    url: str,
    *,
    client: Client | None = None,
    headers: dict[str, str] | None = None,
) -> SimpleNamespace:
    request = http.Request.make(method, url)
    for name, value in (headers or {}).items():
        request.headers[name] = value
    return SimpleNamespace(
        request=request,
        response=None,
        client_conn=client or Client(),
        metadata={},
    )


def connect_flow(
    authority: str = "example.com:443",
    *,
    client: Client | None = None,
    username: str | None = None,
    password: str | None = None,
) -> SimpleNamespace:
    default_username, default_password = signed_proxy_credential()
    username = default_username if username is None else username
    password = default_password if password is None else password
    encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
    flow = request_flow(
        "CONNECT",
        "http://example.com",
        client=client,
        headers={"Proxy-Authorization": f"Basic {encoded}"},
    )
    flow.request.host = authority.rsplit(":", 1)[0]
    flow.request.port = int(authority.rsplit(":", 1)[1]) if ":" in authority else 443
    flow.request.authority = authority
    return flow


def ready_policy(events: list[dict[str, object]]) -> MaintainFlowPolicy:
    return MaintainFlowPolicy(
        config=policy_config(), audit_writer=lambda event: events.append(dict(event))
    )


def mtls_environment(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    now = datetime.now(timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Dialer CA")])
    ca_certificate = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    client_key = ec.generate_private_key(ec.SECP256R1())
    client_certificate = (
        x509.CertificateBuilder()
        .subject_name(
            x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Interceptor")])
        )
        .issuer_name(ca_name)
        .public_key(client_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.UniformResourceIdentifier("spiffe://maintainflow/interceptor")]
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=True
        )
        .sign(ca_key, hashes.SHA256())
    )

    client_directory = tmp_path / "client"
    client_directory.mkdir(parents=True)
    client_identity = client_directory / "policy-dialer.internal.pem"
    client_identity.write_bytes(
        client_certificate.public_bytes(serialization.Encoding.PEM)
        + client_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    client_identity.chmod(0o600)
    server_ca = tmp_path / "server-ca.pem"
    server_ca.write_bytes(ca_certificate.public_bytes(serialization.Encoding.PEM))

    environment = {
        "MF_PROXY_AUDIENCE": PROXY_AUDIENCE,
        "MF_PROXY_VERIFY_KEYS_JSON": json.dumps(
            {
                PROXY_KEY_ID: base64.b64encode(
                    PROXY_PUBLIC_KEY.public_bytes(
                        serialization.Encoding.DER,
                        serialization.PublicFormat.SubjectPublicKeyInfo,
                    )
                ).decode()
            }
        ),
        "MF_AUDIT_HMAC_KEY": "a" * 48,
        "MF_POLICY_VERSION": "browser-egress-2026-01",
        "MF_IMAGE_DIGEST": "sha256:" + "1" * 64,
        "MF_DIALER_PROXY_URL": "https://policy-dialer.internal:9443",
        "MF_DIALER_SERVER_NAME": "policy-dialer.internal",
        "MF_DIALER_CLIENT_CERT_DIR": str(client_directory),
        "MF_DIALER_SERVER_CA_FILE": str(server_ca),
        "MF_DIALER_CLIENT_SPIFFE_ID": "spiffe://maintainflow/interceptor",
        "MF_AUDIT_FD": "3",
    }
    return environment, client_identity, server_ca


@pytest.mark.parametrize(
    "hostname, expected",
    [
        ("EXAMPLE.com.", "example.com"),
        ("shop.example.com", "shop.example.com"),
        ("xn--mnich-kva.example", "xn--mnich-kva.example"),
    ],
)
def test_hostname_normalization(hostname: str, expected: str) -> None:
    assert normalize_hostname(hostname) == expected


@pytest.mark.parametrize(
    "hostname",
    [
        "localhost",
        "service.localhost",
        "127.0.0.1",
        "[::1]",
        "2130706433",
        "user@example.com",
        "example.com%2f.internal",
        "example..com",
        "singlelabel",
        "example.123",
        "münich.example",
        "faß.de",
        "example。com",
    ],
)
def test_hostname_normalization_rejects_ambiguous_or_local_values(
    hostname: str,
) -> None:
    with pytest.raises(ValueError):
        normalize_hostname(hostname)


def test_connect_authority_requires_exact_port_443() -> None:
    assert normalize_connect_authority("Example.com:443") == "example.com"
    for authority in [
        "example.com:0443",
        "example.com:80",
        "example.com",
        "user@example.com:443",
        "[::1]:443",
    ]:
        with pytest.raises(ValueError):
            normalize_connect_authority(authority)


def test_environment_rejects_unsafe_or_non_ed25519_proxy_verify_keys(
    tmp_path: Path,
) -> None:
    environment, _, _ = mtls_environment(tmp_path)
    environment["MF_PROXY_VERIFY_KEYS_JSON"] = json.dumps({"unsafe.key": "bad"})
    with pytest.raises(ValueError, match="invalid key entry"):
        PolicyConfig.from_environ(environment)

    ec_public_key = ec.generate_private_key(ec.SECP256R1()).public_key()
    environment["MF_PROXY_VERIFY_KEYS_JSON"] = json.dumps(
        {
            "primary": base64.b64encode(
                ec_public_key.public_bytes(
                    serialization.Encoding.DER,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                )
            ).decode()
        }
    )
    with pytest.raises(ValueError, match="must use Ed25519"):
        PolicyConfig.from_environ(environment)


def test_environment_accepts_exact_internal_mtls_identity(tmp_path: Path) -> None:
    environment, _, _ = mtls_environment(tmp_path)
    configuration = PolicyConfig.from_environ(environment)

    assert configuration.dialer_server_name == "policy-dialer.internal"
    validate_internal_mtls(configuration)


def test_environment_rejects_mtls_name_spiffe_permissions_and_extra_identity(
    tmp_path: Path,
) -> None:
    environment, client_identity, _ = mtls_environment(tmp_path)

    wrong_name = dict(environment)
    wrong_name["MF_DIALER_SERVER_NAME"] = "other-dialer.internal"
    with pytest.raises(ValueError, match="exact MF_DIALER_SERVER_NAME"):
        PolicyConfig.from_environ(wrong_name)

    wrong_spiffe = dict(environment)
    wrong_spiffe["MF_DIALER_CLIENT_SPIFFE_ID"] = "spiffe://maintainflow/other"
    with pytest.raises(ValueError, match="SPIFFE identity"):
        PolicyConfig.from_environ(wrong_spiffe)

    client_identity.chmod(0o644)
    with pytest.raises(ValueError, match="inaccessible to group"):
        PolicyConfig.from_environ(environment)
    client_identity.chmod(0o600)

    extra_identity = client_identity.parent / "public.example.pem"
    extra_identity.write_bytes(client_identity.read_bytes())
    extra_identity.chmod(0o600)
    with pytest.raises(ValueError, match="contain only the exact dialer SNI"):
        PolicyConfig.from_environ(environment)


def test_environment_rejects_mtls_key_mismatch_and_ca_private_key(
    tmp_path: Path,
) -> None:
    environment, client_identity, _ = mtls_environment(tmp_path)
    client_certificate = x509.load_pem_x509_certificates(client_identity.read_bytes())[
        0
    ]
    mismatched_key = ec.generate_private_key(ec.SECP256R1())
    client_identity.write_bytes(
        client_certificate.public_bytes(serialization.Encoding.PEM)
        + mismatched_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    client_identity.chmod(0o600)
    with pytest.raises(ValueError, match="do not match"):
        PolicyConfig.from_environ(environment)

    environment, _, server_ca = mtls_environment(tmp_path / "second")
    server_ca.write_bytes(server_ca.read_bytes() + b"\nPRIVATE KEY\n")
    with pytest.raises(ValueError, match="must not contain a private key"):
        PolicyConfig.from_environ(environment)


def test_runtime_options_fail_closed_on_each_escape_switch() -> None:
    assert validate_runtime_options(runtime_options(), policy_config()) == []
    for name, unsafe in {
        "mode": ["regular"],
        "ssl_insecure": True,
        "client_certs": "/tmp/one-global-client.pem",
        "ssl_verify_upstream_trusted_ca": None,
        "ssl_verify_upstream_trusted_confdir": "/etc/ssl/certs",
        "tls_version_server_min": "TLS1_1",
        "http_connect_send_host_header": False,
        "upstream_auth": "unsafe:credential",
        "upstream_cert": False,
        "rawtcp": True,
        "websocket": True,
        "http2": False,
        "http3": True,
        "connection_strategy": "eager",
        "body_size_limit": None,
        "stream_large_bodies": None,
        "store_streamed_bodies": True,
        "validate_inbound_headers": False,
        "tcp_timeout": 600,
        "block_global": True,
        "flow_detail": 1,
        "termlog_verbosity": "info",
        "showhost": True,
        "ignore_hosts": ["example.com"],
        "tcp_hosts": [".*"],
        "udp_hosts": [".*"],
    }.items():
        assert name in validate_runtime_options(
            runtime_options(**{name: unsafe}), policy_config()
        )


def test_pinned_https_upstream_matches_go_dialer_protocol() -> None:
    options = Options(http_connect_send_host_header=True)
    client = MitmClient(peername=("browserbase", 1234), sockname=("127.0.0.1", 8080))
    context = Context(client, options)
    context.server.address = ("example.com", 443)
    context.server.via = ("https", ("policy-dialer.internal", 9443))

    stack = _upstream_proxy.HttpUpstreamProxy.make(context, send_connect=True)
    tls_connection = stack[0].tunnel_connection
    assert tls_connection.sni == "policy-dialer.internal"
    assert tls_connection.address == ("policy-dialer.internal", 9443)
    assert b"http/1.1" in tls_connection.alpn_offers

    commands = list(stack[1].start_handshake())
    connect = next(command for command in commands if isinstance(command, SendData))
    assert connect.data == (
        b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"
    )


def test_runtime_requires_the_reviewed_patched_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from h11 import _readers as h11_readers
    from mitmproxy.proxy.layers import http as http_layer
    from mitmproxy.proxy.layers.http import _http1, _http_h2

    verify_patched_parser()
    monkeypatch.setattr(_http1, "MAX_HTTP1_HEADER_BYTES", 1)
    with pytest.raises(ValueError, match="HTTP/1 pre-parse"):
        verify_patched_parser()
    monkeypatch.setattr(_http1, "MAX_HTTP1_HEADER_BYTES", 64 * 1024)
    monkeypatch.setattr(_http_h2, "MAX_HTTP2_HEADER_LIST_BYTES", 1)
    with pytest.raises(ValueError, match="HTTP/2 decompressed"):
        verify_patched_parser()
    monkeypatch.setattr(_http_h2, "MAX_HTTP2_HEADER_LIST_BYTES", 64 * 1024)
    monkeypatch.setattr(http_layer, "MAINTAINFLOW_STREAM_LIMITS_PATCHED", False)
    with pytest.raises(ValueError, match="cumulative stream"):
        verify_patched_parser()
    monkeypatch.setattr(http_layer, "MAINTAINFLOW_STREAM_LIMITS_PATCHED", True)
    monkeypatch.setattr(h11_readers, "MAINTAINFLOW_MAX_CHUNK_HEADER_BYTES", 1)
    with pytest.raises(ValueError, match="chunk framing"):
        verify_patched_parser()


def test_outer_connect_authenticates_strips_header_and_emits_safe_audit() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    flow = connect_flow(authority="EXAMPLE.com.:443")

    addon.http_connect(flow)

    assert flow.response is None
    assert "Proxy-Authorization" not in flow.request.headers
    assert flow.request.authority == "example.com:443"
    assert events[0]["decision"] == "allowed"
    assert events[0]["reason_code"] == "connect_allowed"
    encoded = json.dumps(events[0], sort_keys=True)
    assert "example.com" not in encoded
    assert PROXY_KEY_ID not in encoded
    assert "A" * 22 not in encoded


def test_outer_connect_rejects_bad_auth_and_non_443_without_leaking() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    bad_auth = connect_flow(password="wrong-password")
    addon.http_connect(bad_auth)
    assert bad_auth.response.status_code == 407
    assert "Proxy-Authorization" not in bad_auth.request.headers

    bad_port = connect_flow(authority="example.com:8443")
    addon.http_connect(bad_port)
    assert bad_port.response.status_code == 403
    assert events[-1]["reason_code"] == "connect_port_forbidden"


def test_outer_connect_rejects_http2_multiplexing_and_clears_prior_auth() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))

    multiplexed = connect_flow(client=client)
    multiplexed.request.http_version = "HTTP/2.0"
    addon.http_connect(multiplexed)

    assert multiplexed.response.status_code == 403
    assert "Proxy-Authorization" not in multiplexed.request.headers
    assert events[-1]["reason_code"] == "connect_http_version_forbidden"

    stale_tunnel_request = request_flow(
        "GET", "https://example.com/", client=client
    )
    addon.requestheaders(stale_tunnel_request)
    assert stale_tunnel_request.response.status_code == 407
    assert events[-1]["reason_code"] == "connect_auth_required"


def test_signed_proxy_credential_verifies_exact_audience_signature_and_expiry() -> None:
    now = 2_000_000_000
    username, password = signed_proxy_credential(now=now)
    claims = verify_proxy_credential(
        username,
        password,
        audience=PROXY_AUDIENCE,
        verify_keys=proxy_verify_keys(),
        now=now,
    )
    assert claims is not None
    assert claims.subject == "run:00000000-0000-4000-8000-000000000001"
    assert claims.side_effect_hosts == frozenset({"example.com"})
    assert (
        verify_proxy_credential(
            username,
            password,
            audience="another-gateway",
            verify_keys=proxy_verify_keys(),
            now=now,
        )
        is None
    )

    unsafe_integer_username, unsafe_integer_password = signed_proxy_credential(
        now=(1 << 53)
    )
    assert (
        verify_proxy_credential(
            unsafe_integer_username,
            unsafe_integer_password,
            audience=PROXY_AUDIENCE,
            verify_keys=proxy_verify_keys(),
            now=(1 << 53),
        )
        is None
    )
    assert (
        verify_proxy_credential(
            username,
            password[:-1] + ("A" if password[-1] != "A" else "B"),
            audience=PROXY_AUDIENCE,
            verify_keys=proxy_verify_keys(),
            now=now,
        )
        is None
    )
    assert (
        verify_proxy_credential(
            username,
            password,
            audience=PROXY_AUDIENCE,
            verify_keys=proxy_verify_keys(),
            now=now + 900,
        )
        is None
    )


def test_shared_v1_contract_fixture_verifies_in_the_gateway() -> None:
    fixture = json.loads(
        (
            Path(__file__).parents[1]
            / "testdata"
            / "proxy-credential-v1.json"
        ).read_text(encoding="utf-8")
    )
    public_key = serialization.load_der_public_key(
        base64.b64decode(fixture["publicKeySpkiBase64"], validate=True)
    )
    assert isinstance(public_key, Ed25519PublicKey)
    claims = verify_proxy_credential(
        fixture["username"],
        fixture["password"],
        audience=fixture["audience"],
        verify_keys={fixture["keyId"]: public_key},
        now=fixture["now"],
    )
    assert claims is not None
    assert claims.subject == fixture["claims"]["sub"]
    assert claims.expires_at == fixture["claims"]["exp"]
    assert sorted(claims.side_effect_hosts) == fixture["claims"]["seh"]


def test_read_only_credential_blocks_side_effect_methods_on_the_exact_host() -> None:
    events: list[dict[str, object]] = []
    username, password = signed_proxy_credential(side_effect_hosts=[])
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(
        connect_flow(client=client, username=username, password=password)
    )

    read = request_flow("GET", "https://example.com/", client=client)
    addon.requestheaders(read)
    assert read.response is None

    side_effect = request_flow(
        "POST",
        "https://example.com/",
        client=client,
        headers={"Content-Length": "0"},
    )
    addon.requestheaders(side_effect)
    assert side_effect.response.status_code == 403
    assert events[-1]["reason_code"] == "side_effect_host_forbidden"


def test_side_effect_credential_is_host_scoped_and_rechecked_for_expiry() -> None:
    now = [2_000_000_000.0]
    username, password = signed_proxy_credential(
        now=int(now[0]), side_effect_hosts=["example.com"]
    )
    events: list[dict[str, object]] = []
    addon = MaintainFlowPolicy(
        config=policy_config(),
        audit_writer=lambda event: events.append(dict(event)),
        wall_clock=lambda: now[0],
    )
    client = Client()
    addon.http_connect(
        connect_flow(client=client, username=username, password=password)
    )
    allowed = request_flow(
        "POST",
        "https://example.com/",
        client=client,
        headers={"Content-Length": "0"},
    )
    addon.requestheaders(allowed)
    assert allowed.response is None

    now[0] += 900
    expired = request_flow("GET", "https://example.com/", client=client)
    addon.requestheaders(expired)
    assert expired.response.status_code == 407
    assert events[-1]["reason_code"] == "proxy_credential_expired"


def test_side_effect_credential_requires_an_exact_signed_hostname() -> None:
    username, password = signed_proxy_credential(
        side_effect_hosts=["example.com"]
    )
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(
        connect_flow(
            authority="forms.example.com:443",
            client=client,
            username=username,
            password=password,
        )
    )
    blocked_subdomain = request_flow(
        "POST",
        "https://forms.example.com/submit",
        client=client,
        headers={"Content-Length": "0"},
    )
    addon.requestheaders(blocked_subdomain)
    assert blocked_subdomain.response.status_code == 403
    assert events[-1]["reason_code"] == "side_effect_host_forbidden"

    exact_username, exact_password = signed_proxy_credential(
        side_effect_hosts=["forms.example.com"]
    )
    exact_client = Client()
    addon.http_connect(
        connect_flow(
            authority="forms.example.com:443",
            client=exact_client,
            username=exact_username,
            password=exact_password,
        )
    )
    allowed_exact_host = request_flow(
        "POST",
        "https://forms.example.com/submit",
        client=exact_client,
        headers={"Content-Length": "0"},
    )
    addon.requestheaders(allowed_exact_host)
    assert allowed_exact_host.response is None


def test_inner_https_request_requires_authenticated_matching_tunnel() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    outer = connect_flow(client=client)
    addon.http_connect(outer)

    allowed = request_flow(
        "GET", "https://example.com/path?sentinel=secret", client=client
    )
    addon.requestheaders(allowed)
    assert allowed.response is None
    assert allowed.request.headers["Accept-Encoding"] == "identity"

    mismatched = request_flow("GET", "https://other.example/path", client=client)
    addon.requestheaders(mismatched)
    assert mismatched.response.status_code == 403
    assert events[-1]["reason_code"] == "authority_mismatch"

    unauthenticated = request_flow("GET", "http://example.com/", client=Client())
    addon.requestheaders(unauthenticated)
    assert unauthenticated.response.status_code == 407


@pytest.mark.parametrize(
    "method, headers, reason",
    [
        (
            "GET",
            {"Upgrade": "websocket", "Connection": "Upgrade"},
            "protocol_upgrade_forbidden",
        ),
        ("GET", {"Sec-WebSocket-Version": "13"}, "protocol_upgrade_forbidden"),
        (
            "GET",
            {"Sec-WebTransport-Http3-Draft": "draft02"},
            "protocol_upgrade_forbidden",
        ),
        ("CONNECT", {}, "extended_connect_forbidden"),
        ("TRACE", {}, "method_forbidden"),
        ("POST", {"Transfer-Encoding": "chunked"}, "chunked_request_forbidden"),
        (
            "POST",
            {"Content-Length": str(MAX_REQUEST_BODY_BYTES + 1)},
            "request_body_too_large",
        ),
    ],
)
def test_protocol_and_request_limits_block_before_forwarding(
    method: str, headers: dict[str, str], reason: str
) -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))
    flow = request_flow(method, "https://example.com/", client=client, headers=headers)

    addon.requestheaders(flow)

    assert flow.response is not None
    assert events[-1]["reason_code"] == reason


def test_response_strips_alt_svc_and_rejects_upgrade_and_oversize() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))

    allowed = request_flow("GET", "https://example.com/", client=client)
    allowed.response = http.Response.make(200, b"ok", {"Alt-Svc": 'h3=":443"'})
    addon.responseheaders(allowed)
    assert "Alt-Svc" not in allowed.response.headers

    upgrade = request_flow("GET", "https://example.com/", client=client)
    upgrade.response = http.Response.make(101, b"", {"Upgrade": "websocket"})
    addon.responseheaders(upgrade)
    assert upgrade.response.status_code == 502
    assert events[-1]["reason_code"] == "upstream_upgrade_forbidden"

    oversized = request_flow("GET", "https://example.com/", client=client)
    oversized.response = http.Response.make(200, b"")
    oversized.response.headers["Content-Length"] = str(MAX_RESPONSE_BODY_BYTES + 1)
    addon.responseheaders(oversized)
    assert oversized.response.status_code == 502
    assert events[-1]["reason_code"] == "response_body_too_large"


def test_compressed_messages_are_rejected_before_body_processing() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))

    request = request_flow(
        "POST",
        "https://example.com/",
        client=client,
        headers={"Content-Length": "10", "Content-Encoding": "gzip"},
    )
    addon.requestheaders(request)
    assert request.response.status_code == 403
    assert events[-1]["reason_code"] == "compressed_request_forbidden"

    response = request_flow("GET", "https://example.com/", client=client)
    response.response = http.Response.make(200, b"")
    response.response.headers["Content-Encoding"] = "br"
    addon.responseheaders(response)
    assert response.response.status_code == 502
    assert events[-1]["reason_code"] == "compressed_response_forbidden"


@pytest.mark.parametrize(
    "transfer_encoding",
    ["gzip", "deflate", "gzip, chunked", "deflate, chunked", "chunked, chunked"],
)
def test_response_rejects_non_plain_transfer_encoding(
    transfer_encoding: str,
) -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))
    flow = request_flow("GET", "https://example.com/", client=client)
    flow.response = http.Response.make(
        200, b"", {"Transfer-Encoding": transfer_encoding}
    )

    addon.responseheaders(flow)

    assert flow.response.status_code == 502
    assert events[-1]["reason_code"] == "response_transfer_encoding_forbidden"


@pytest.mark.parametrize(
    "transfer_encoding", [None, "identity", "chunked", " CHUNKED "]
)
def test_response_allows_only_identity_or_plain_chunked_transfer_encoding(
    transfer_encoding: str | None,
) -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))
    headers = (
        {} if transfer_encoding is None else {"Transfer-Encoding": transfer_encoding}
    )
    flow = request_flow("GET", "https://example.com/", client=client)
    flow.response = http.Response.make(200, b"", headers)

    addon.responseheaders(flow)

    assert flow.response.status_code == 200


def test_response_rejects_duplicate_plain_chunked_fields() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    client = Client()
    addon.http_connect(connect_flow(client=client))
    flow = request_flow("GET", "https://example.com/", client=client)
    flow.response = http.Response.make(200, b"")
    flow.response.headers.add("Transfer-Encoding", "chunked")
    flow.response.headers.add("Transfer-Encoding", "chunked")

    addon.responseheaders(flow)

    assert flow.response.status_code == 502
    assert events[-1]["reason_code"] == "response_transfer_encoding_forbidden"


def test_raw_protocol_backstops_kill_flow() -> None:
    events: list[dict[str, object]] = []
    addon = ready_policy(events)
    for hook in [addon.websocket_start, addon.tcp_start, addon.udp_start]:
        flow = Killable()
        hook(flow)
        assert flow.killed is True


def test_audit_failure_fails_request_closed() -> None:
    def broken_writer(_event: dict[str, object]) -> None:
        raise OSError("sink unavailable")

    addon = MaintainFlowPolicy(config=policy_config(), audit_writer=broken_writer)
    flow = connect_flow()
    addon.http_connect(flow)
    assert flow.response.status_code == 503
