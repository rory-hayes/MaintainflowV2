from __future__ import annotations

import base64
import importlib.util
import ipaddress
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


DEPLOY_ROOT = Path(__file__).resolve().parents[1]
PROXY_ROOT = DEPLOY_ROOT.parent
REPO_ROOT = PROXY_ROOT.parents[1]


def _load_module(name: str, path: Path):
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


guard = _load_module("maintainflow_runtime_guard", DEPLOY_ROOT / "runtime_guard.py")
verify = _load_module("maintainflow_verify_scaffold", DEPLOY_ROOT / "verify_scaffold.py")


def _encoded(contents: bytes) -> str:
    return base64.b64encode(contents).decode("ascii")


FAKE_CERT = b"-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n"
FAKE_KEY = b"-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n"
FAKE_ED25519_SPKI = bytes.fromhex("302a300506032b6570032100") + b"k" * 32


class StaticTopologyTests(unittest.TestCase):
    def test_committed_scaffold_invariants(self) -> None:
        verify.verify_all()

    def test_committed_templates_are_deliberately_not_rendered(self) -> None:
        with self.assertRaises(verify.VerificationError):
            verify.verify_all(require_rendered=True)

    def test_ci_preserves_full_reports_and_blocks_fixable_highs(self) -> None:
        workflow = (REPO_ROOT / ".github/workflows/ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("ignore-unfixed: false", workflow)
        self.assertIn("ignore-unfixed: true", workflow)
        self.assertIn(
            "browser-egress-${{ matrix.component }}-vulnerabilities.json",
            workflow,
        )
        self.assertIn(
            "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
            workflow,
        )
        self.assertNotIn(".trivyignore", workflow)

        residual_review = (
            REPO_ROOT
            / "docs/business-evals/BROWSER_EGRESS_CONTAINER_RESIDUAL_RISK.md"
        ).read_text(encoding="utf-8")
        self.assertIn("CVE-2026-54369", residual_review)
        self.assertIn("CVE-2025-69720", residual_review)

    def test_exposure_autostop_and_persistence_drift_are_rejected(self) -> None:
        interceptor_source = (DEPLOY_ROOT / "fly-interceptor.toml").read_text(
            encoding="utf-8"
        )
        dialer_source = (DEPLOY_ROOT / "fly-dialer.toml").read_text(
            encoding="utf-8"
        )
        mutations = (
            (
                interceptor_source.replace('handlers = ["tls"]', 'handlers = ["tls", "http"]'),
                dialer_source,
            ),
            (
                interceptor_source.replace('auto_stop_machines = "off"', 'auto_stop_machines = "stop"'),
                dialer_source,
            ),
            (
                interceptor_source.replace('persist_rootfs = "never"', 'persist_rootfs = "always"'),
                dialer_source,
            ),
            (
                interceptor_source,
                dialer_source.replace('persist_rootfs = "never"', 'persist_rootfs = "always"'),
            ),
            (
                interceptor_source,
                dialer_source + '\n[[services]]\ninternal_port = 9443\nprotocol = "tcp"\n',
            ),
        )
        for interceptor_text, dialer_text in mutations:
            with self.subTest(interceptor=interceptor_text[-80:], dialer=dialer_text[-80:]):
                with tempfile.TemporaryDirectory() as temporary:
                    interceptor_path = Path(temporary) / "interceptor.toml"
                    dialer_path = Path(temporary) / "dialer.toml"
                    interceptor_path.write_text(interceptor_text, encoding="utf-8")
                    dialer_path.write_text(dialer_text, encoding="utf-8")
                    with self.assertRaises(verify.VerificationError):
                        verify.verify_fly_configs(interceptor_path, dialer_path)

    def test_shell_entrypoints_parse(self) -> None:
        for script in (
            DEPLOY_ROOT / "scripts/interceptor-entrypoint.sh",
            DEPLOY_ROOT / "scripts/dialer-entrypoint.sh",
        ):
            subprocess.run(["sh", "-n", str(script)], check=True)
            contents = script.read_text(encoding="utf-8")
            self.assertIn('"${runtime_directory}"', contents)
            self.assertIn("install -d -m 0711", contents)
        subprocess.run(["bash", "-n", str(DEPLOY_ROOT / "scripts/internal-pki.sh")], check=True)


class RuntimeGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ipv4_registry = PROXY_ROOT / "policy/iana-ipv4-special-registry.xml"
        cls.ipv6_registry = PROXY_ROOT / "policy/iana-ipv6-special-registry.xml"
        cls.policy_manifest = PROXY_ROOT / "policy/policy-manifest.json"

    def test_dot_configuration_requires_two_distinct_numeric_endpoints(self) -> None:
        endpoints = guard.parse_dot_resolvers(
            "1.1.1.1:853|one.one.one.one,[2606:4700:4700::1111]:853|cloudflare-dns.com"
        )
        self.assertEqual(len(endpoints), 2)
        for invalid in (
            "1.1.1.1:853|one.one.one.one",
            "1.1.1.1:53|one.one.one.one,9.9.9.9:853|dns.quad9.net",
            "1.1.1.1:853|one.one.one.one,1.1.1.1:853|other.example",
            "resolver.example:853|one.one.one.one,9.9.9.9:853|dns.quad9.net",
        ):
            with self.assertRaises(guard.RuntimeGateError):
                guard.parse_dot_resolvers(invalid)

    def test_proxy_verification_keys_are_bounded_ed25519_spki(self) -> None:
        encoded = _encoded(FAKE_ED25519_SPKI)
        keys = guard.parse_proxy_verify_keys(json.dumps({"primary_2026": encoded}))
        self.assertEqual(keys["primary_2026"], FAKE_ED25519_SPKI)
        for invalid in (
            "{}",
            json.dumps({"unsafe.key": encoded}),
            json.dumps({"primary": _encoded(b"not-ed25519")}),
            json.dumps({str(index): encoded for index in range(5)}),
        ):
            with self.assertRaises(guard.RuntimeGateError):
                guard.parse_proxy_verify_keys(invalid)

    def test_iana_firewall_backstop_covers_private_metadata_fly_and_multicast(self) -> None:
        blocked_v4, blocked_v6 = guard.load_special_networks(
            self.ipv4_registry, self.ipv6_registry, self.policy_manifest
        )
        for address in ("10.0.0.1", "169.254.169.254", "224.0.0.1"):
            parsed = ipaddress.ip_address(address)
            self.assertTrue(any(parsed in network for network in blocked_v4))
        for address in ("fdaa::1", "fe80::1", "fec0::1", "ff02::1"):
            parsed = ipaddress.ip_address(address)
            self.assertTrue(any(parsed in network for network in blocked_v6))

        with tempfile.TemporaryDirectory() as temporary:
            tampered_ipv4 = Path(temporary) / "ipv4.xml"
            tampered_ipv4.write_bytes(self.ipv4_registry.read_bytes() + b"\n")
            with self.assertRaises(guard.RuntimeGateError):
                guard.load_special_networks(
                    tampered_ipv4,
                    self.ipv6_registry,
                    self.policy_manifest,
                )

    def test_rendered_dialer_firewall_is_default_drop_and_port_bounded(self) -> None:
        blocked_v4, blocked_v6 = guard.load_special_networks(
            self.ipv4_registry, self.ipv6_registry, self.policy_manifest
        )
        endpoints = guard.parse_dot_resolvers(
            "1.1.1.1:853|one.one.one.one,[2606:4700:4700::1111]:853|cloudflare-dns.com"
        )
        rules = guard.render_dialer_firewall(endpoints, blocked_v4, blocked_v6)
        self.assertEqual(rules.count("policy drop"), 2)
        self.assertIn("1.1.1.1", rules)
        self.assertIn("2606:4700:4700::1111", rules)
        self.assertIn("tcp dport 853 accept", rules)
        self.assertIn("tcp dport 443 accept", rules)
        self.assertIn("ip6 saddr fdaa::/16 tcp dport 9443 accept", rules)
        self.assertIn("icmpv6 type { 133, 134, 135, 136 } accept", rules)
        self.assertNotIn("echo-request", rules)
        self.assertNotIn("udp dport", rules)
        self.assertNotIn("dport 53", rules)

    def test_prepare_dialer_writes_private_material_and_rejects_private_dot(self) -> None:
        base_environment = {
            "FLY_PRIVATE_IP": "fdaa:0:1::1234",
            "MF_DIALER_ALLOWED_CLIENT_SPIFFE_ID": guard.EXPECTED_SPIFFE_ID,
            "MF_DIALER_IMAGE_DIGEST": "sha256:" + "1" * 64,
            "MF_DIALER_AUDIT_PEPPER": "a" * 48,
            "MF_DIALER_DOT_RESOLVERS": "1.1.1.1:853|one.one.one.one,9.9.9.9:853|dns.quad9.net",
            "MF_DIALER_SERVER_CERT_B64": _encoded(FAKE_CERT),
            "MF_DIALER_SERVER_KEY_B64": _encoded(FAKE_KEY),
            "MF_DIALER_CLIENT_CA_B64": _encoded(FAKE_CERT),
        }
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            output = runtime / "firewall.nft"
            endpoints = guard.prepare_dialer(
                base_environment,
                runtime,
                output,
                self.ipv4_registry,
                self.ipv6_registry,
                self.policy_manifest,
            )
            self.assertEqual(len(endpoints), 2)
            for name in (
                "dialer-server.pem",
                "dialer-server.key",
                "interceptor-client-ca.pem",
                "firewall.nft",
            ):
                path = runtime / name
                self.assertTrue(path.is_file())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

        invalid = dict(base_environment)
        invalid["MF_DIALER_DOT_RESOLVERS"] = (
            "10.0.0.1:853|private.example,9.9.9.9:853|dns.quad9.net"
        )
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(guard.RuntimeGateError):
                guard.prepare_dialer(
                    invalid,
                    Path(temporary),
                    Path(temporary) / "firewall.nft",
                    self.ipv4_registry,
                    self.ipv6_registry,
                    self.policy_manifest,
                )

    def test_prepare_interceptor_pins_only_validated_6pn_answers(self) -> None:
        environment = {
            "MF_DIALER_SERVER_NAME": "policy-dialer.internal",
            "MF_DIALER_PROXY_URL": "https://policy-dialer.internal:9443",
            "MF_DIALER_CLIENT_SPIFFE_ID": guard.EXPECTED_SPIFFE_ID,
            "MF_PROXY_AUDIENCE": "maintainflow-browser-egress",
            "MF_PROXY_VERIFY_KEYS_JSON": json.dumps(
                {"primary_2026": _encoded(FAKE_ED25519_SPKI)}
            ),
            "MF_AUDIT_HMAC_KEY": "a" * 48,
            "MF_POLICY_VERSION": "browser-egress-2026-01",
            "MF_IMAGE_DIGEST": "sha256:" + "2" * 64,
            "MF_DIALER_CLIENT_IDENTITY_B64": _encoded(FAKE_CERT + FAKE_KEY),
            "MF_DIALER_SERVER_CA_B64": _encoded(FAKE_CERT),
            "MF_INTERCEPTION_CA_PEM_B64": _encoded(FAKE_CERT + FAKE_KEY),
        }
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            addresses = guard.prepare_interceptor(
                environment,
                runtime,
                runtime / "dialers.nft",
                runtime / "dialers.hosts",
                resolver=lambda _: (ipaddress.ip_address("fdaa:0:1::10"),),
            )
            self.assertEqual(tuple(map(str, addresses)), ("fdaa:0:1::10",))
            self.assertIn(
                "fdaa:0:1::10",
                (runtime / "dialers.nft").read_text(encoding="ascii"),
            )
            identity = runtime / "dialer-client/policy-dialer.internal.pem"
            self.assertEqual(stat.S_IMODE(identity.stat().st_mode), 0o600)

        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            with self.assertRaises(guard.RuntimeGateError):
                guard.prepare_interceptor(
                    environment,
                    runtime,
                    runtime / "dialers.nft",
                    runtime / "dialers.hosts",
                    resolver=lambda _: (ipaddress.ip_address("2606:4700:4700::1111"),),
                )


@unittest.skipUnless(shutil.which("openssl") and shutil.which("bash"), "OpenSSL and Bash are required")
class InternalPKITests(unittest.TestCase):
    def test_generate_verify_and_overlap_bundle_are_hermetic(self) -> None:
        script = DEPLOY_ROOT / "scripts/internal-pki.sh"
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            first = temporary_path / "first"
            second = temporary_path / "second"
            spiffe = guard.EXPECTED_SPIFFE_ID
            hostname = "policy-dialer.internal"
            subprocess.run(
                ["bash", str(script), "generate", str(first), hostname, spiffe, "2"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            subprocess.run(
                ["bash", str(script), "verify", str(first), hostname, spiffe],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            subprocess.run(
                ["bash", str(script), "generate", str(second), hostname, spiffe, "2"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            bundle = temporary_path / "overlap-ca.pem"
            subprocess.run(
                [
                    "bash",
                    str(script),
                    "bundle",
                    str(first / "dialer-server-ca.pem"),
                    str(second / "dialer-server-ca.pem"),
                    str(bundle),
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(bundle.read_text(encoding="ascii").count("BEGIN CERTIFICATE"), 2)
            self.assertEqual(stat.S_IMODE(bundle.stat().st_mode), 0o600)
            self.assertFalse(any(path.is_symlink() for path in first.iterdir()))


if __name__ == "__main__":
    unittest.main()
