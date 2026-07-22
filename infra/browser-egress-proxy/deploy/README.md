# Fly deployment scaffold for the browser-egress boundary

This directory is an additive, **non-deployed** production scaffold for the
two-app security boundary. It does not create Fly apps, allocate IPs,
purchase a plan, upload a certificate, set a secret, or enable the Maintain
Flow runner. The committed Fly files retain deliberate `replace-with-reviewed`
app-name placeholders.

Passing the tests here proves configuration intent only. It is not evidence
that Fly, Browserbase, DNS-over-TLS, nftables, certificate interception, audit
retention, or a real customer journey works in production.

## Locked topology

```text
Browserbase HTTPS proxy client
              |
              | TLS 1.2/1.3; ALPN http/1.1; public port 443 only
              v
    Fly public interceptor app (2+ Machines)
      mitmproxy on internal TCP 8080
      outbound firewall:
        - fdaa::3 TCP/UDP 53 (Fly DNS)
        - startup-pinned dialer 6PN IPs TCP 9443
        - established traffic, loopback, and minimal IPv6 discovery control
              |
              | exact internal CA + client SPIFFE mTLS
              v
    Fly private policy-dialer app (2+ Machines)
      no services, public IP, Flycast IP, or public listener
      exact FLY_PRIVATE_IP:9443; health only on 127.0.0.1:8081
      outbound firewall:
        - exactly two reviewed numeric DoT IPs, TCP 853
        - public target IPs, TCP 443
        - established traffic, loopback, and minimal IPv6 discovery control
        - all other TCP and every UDP flow dropped
```

The dialer firewall independently blocks every prefix in the checked-in IANA
special-purpose snapshots plus multicast and deprecated IPv6 site-local space
before allowing target TCP 443. The Go dialer still owns the stronger
per-request all-answer policy,
one exact selected-IP connection, time/byte limits, and deterministic audit.
Only ICMPv6 router/neighbor discovery types 133-136 are additionally admitted
for the Fly IPv6 network. Echo is not allowed, and the workload runs without
`CAP_NET_RAW` or any other retained capability.

The interceptor authenticates a short-lived, per-session signed credential.
It requires one audience and between one and four Ed25519 public verification
keys. There is no static shared proxy username/password in this scaffold.

## Why the Fly files look this way

- Fly documents that a raw `tls` handler can terminate edge TLS and pass the
  resulting TCP stream to the internal service. The public app therefore has
  one port, `443`, one handler, `tls`, and ALPN restricted to `http/1.1`.
- Fly documents that private 6PN services bind to `fly-local-6pn` or the
  Machine's `FLY_PRIVATE_IP`, while `<app>.internal` resolves the started
  Machines. The dialer binds its exact numeric `FLY_PRIVATE_IP` and has no Fly
  service section.
- Autostop is explicitly off on the public service. A private app without a
  service is not managed by Fly Proxy autostop, and both apps use bounded
  `on-failure` restarts. Both VM profiles explicitly use
  `persist_rootfs = "never"`, keeping root filesystems ephemeral across
  restart or replacement. Every startup gate exits non-zero on failure.
- The dialer's health listener remains loopback-only. Fly top-level checks
  require their port on `0.0.0.0`, so adding one would weaken this boundary.
  Health-check failure also does not itself restart a Fly Machine. Runtime
  supervision therefore relies on process exit plus separately approved
  external monitoring, not a publicly reachable health port.

Authoritative Fly references used for the templates:

- [App configuration, TLS handlers, restart policies, and top-level check requirements](https://fly.io/docs/reference/configuration/)
- [Private 6PN networking, `.internal` DNS, `FLY_PRIVATE_IP`, and `fdaa::3`](https://fly.io/docs/networking/private-networking/)
- [Public service versus direct private-service binding](https://fly.io/docs/networking/app-services/)
- [Autostop behavior, including private apps without services](https://fly.io/docs/launch/autostop-autostart/)
- [Machine restart-policy semantics](https://fly.io/docs/machines/guides-examples/machine-restart-policy/)
- [Health checks do not automatically restart Machines](https://fly.io/docs/reference/health-checks/)

## Files

- `fly-interceptor.toml`: one public raw-TLS service, no HTTP handler, no
  autostop, service-level TCP routing check.
- `fly-dialer.toml`: no services, public ports, top-level checks, metrics,
  volumes, or statics.
- `images/`: digest-pinned base images that install the startup firewall and
  privilege-drop wrapper around the reviewed gateway artifacts.
- `../../../docs/business-evals/BROWSER_EGRESS_CONTAINER_VULNERABILITY_POLICY.md`:
  the two-pass full-report plus fixable-finding release gate.
- `firewall/`: default-drop bootstrap rules installed before runtime material
  is read and before either workload starts.
- `runtime_guard.py`: strict env, secret, private-DNS, resolver, IANA snapshot,
  and nftables-rule preparation. It never logs a secret or destination.
- `scripts/internal-pki.sh`: offline internal mTLS issuance, verification, and
  overlap-bundle generation. It does not create the separate Browserbase
  interception CA.
- `verify_scaffold.py` and `tests/`: hermetic static and negative-path checks.

## Local static verification

From the repository root:

```sh
python3 infra/browser-egress-proxy/deploy/verify_scaffold.py
python3 -m unittest discover -s infra/browser-egress-proxy/deploy/tests -v
```

These checks use no network. If Docker, nftables, or `flyctl` is missing, the
static suite still runs; container syntax/build and Fly runtime evidence remain
unproven and must stay on the release-blocker list.

## Operator-only internal PKI

Generate the internal CA and 90-day leaf identities only after final app names
are approved. The output path must be access-controlled and outside source
control (or under the ignored `pki-output/` directory):

```sh
bash infra/browser-egress-proxy/deploy/scripts/internal-pki.sh generate \
  /approved/private/operator/path/rotation-001 \
  approved-policy-dialer-app.internal \
  spiffe://maintainflow/interceptor \
  90
```

The output contains separate offline dialer-server and interceptor-client CA
private keys, both CA certificates, both leaves and keys, the exact-SNI
combined client identity, and a public fingerprint/expiry manifest. Separating
the roots prevents either trust bundle from authorizing the opposite role. The
script verifies chain purpose, exact DNS SAN,
exact URI SAN, key matching, validity, and file permissions. Never commit,
paste, or log the output.

For rotation, generate a new directory rather than overwriting the old one.
Create an overlap trust bundle:

```sh
bash infra/browser-egress-proxy/deploy/scripts/internal-pki.sh bundle \
  /approved/private/operator/path/rotation-001/dialer-server-ca.pem \
  /approved/private/operator/path/rotation-002/dialer-server-ca.pem \
  /approved/private/operator/path/dialer-server-overlap-ca.pem

bash infra/browser-egress-proxy/deploy/scripts/internal-pki.sh bundle \
  /approved/private/operator/path/rotation-001/interceptor-client-ca.pem \
  /approved/private/operator/path/rotation-002/interceptor-client-ca.pem \
  /approved/private/operator/path/interceptor-client-overlap-ca.pem
```

Roll out the dialer-server overlap bundle to the interceptor and the
interceptor-client overlap bundle to the dialer, then the new server and client
leaf identities. Verify canaries before removing either old CA. A failed step
keeps the gateway disabled. The Browserbase interception CA is a separate
trust domain and requires its own reviewed generation, custody, provider
upload, and rotation process.

## Runtime values that must not be committed

The public interceptor requires:

- `MF_PROXY_VERIFY_KEYS_JSON`: JSON object of 1-4 safe key IDs to base64 DER
  Ed25519 SPKI public keys. Its audience must equal committed
  `MF_PROXY_AUDIENCE` and the app's signing audience.
- `MF_AUDIT_HMAC_KEY` and the reviewed interceptor `MF_IMAGE_DIGEST`.
- `MF_DIALER_CLIENT_IDENTITY_B64` and `MF_DIALER_SERVER_CA_B64`.
- `MF_INTERCEPTION_CA_PEM_B64`, the separate combined interception CA
  certificate/key already approved for Browserbase trust.

The private dialer requires:

- `MF_DIALER_DOT_RESOLVERS` in exact
  `IP:853|tls-name,IP:853|tls-name` form. IPv6 uses `[IP]:853`. The two IPs
  and TLS names must be distinct, public, numeric, and independently reviewed.
- `MF_DIALER_AUDIT_PEPPER` and the reviewed dialer
  `MF_DIALER_IMAGE_DIGEST`.
- `MF_DIALER_SERVER_CERT_B64`, `MF_DIALER_SERVER_KEY_B64`, and
  `MF_DIALER_CLIENT_CA_B64`.

Internal PKI file mapping:

| Runtime value | Generated file |
| --- | --- |
| `MF_DIALER_CLIENT_IDENTITY_B64` | `<dialer-app>.internal.pem` |
| `MF_DIALER_SERVER_CA_B64` | `dialer-server-ca.pem` (or its overlap bundle) |
| `MF_DIALER_SERVER_CERT_B64` | `dialer.pem` |
| `MF_DIALER_SERVER_KEY_B64` | `dialer.key` |
| `MF_DIALER_CLIENT_CA_B64` | `interceptor-client-ca.pem` (or its overlap bundle) |

Base64 values are decoded into fresh private `/run/maintainflow/...` files,
then removed from the child process environment where the workload does not
need them. The signed-proxy verification key JSON remains in the interceptor
environment because every connection is verified at request time; it contains
public keys only. Private signing keys remain in the application/runner and
must never be present on the gateway.

### Signed proxy key rotation

Treat proxy-signing rotation as an overlap deployment; never replace both
sides at once:

1. Generate a new PKCS#8 Ed25519 private key in approved private custody.
   Record only the new safe key ID and public-key fingerprint in the change
   record—never the private DER or its base64 value.
2. Add the new SPKI public key beside the old key in
   `MF_PROXY_VERIFY_KEYS_JSON` (maximum four keys). Deploy the interceptor and
   prove it accepts a test credential signed by the new key while still
   accepting the old key.
3. Switch Vercel's `BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID` and
   `BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64` to the new key. The
   private key remains app-only. Keep the audience unchanged and canary a real
   short-lived session.
4. Wait at least the 15-minute maximum credential lifetime **plus** confirmed
   Browserbase session drain. A wall-clock wait alone is not sufficient if an
   old session is still active.
5. Remove the old public key from `MF_PROXY_VERIFY_KEYS_JSON`, redeploy the
   interceptor, then canary that a new-key credential is accepted and an
   otherwise valid old-key credential is rejected.

Any mismatch, unexpected active session, or failed rejection leaves both
public keys installed and the runner disabled while the cause is investigated.

## Approval-only provisioning sequence

Do not execute these steps from this repository until spend, Fly organization,
regions, app names, resolver operators, PKI custody, and public hostname are
approved.

1. Copy both TOML templates into the ignored `deploy/rendered/` directory.
   Replace the two app names and matching `.internal` host; keep every topology
   invariant unchanged.
2. Verify rendered files locally with `verify_scaffold.py --require-rendered`
   and the `--interceptor-config` / `--dialer-config` options.
3. Run `fly config validate` against both rendered configs. This is required;
   the local strict parser is not a substitute for the current Fly CLI.
4. Build each image from the repository root, capture its immutable registry
   digest, dependency/SBOM evidence, and vulnerability scan, and set the exact
   digest runtime receipt. A mutable tag is not an approval artifact.
   Apply the repository's
   [container vulnerability policy](../../../docs/business-evals/BROWSER_EGRESS_CONTAINER_VULNERABILITY_POLICY.md)
   and revalidate the
   [residual-risk review](../../../docs/business-evals/BROWSER_EGRESS_CONTAINER_RESIDUAL_RISK.md)
   against those exact image reports.
5. Create two apps in the same approved Fly organization/private network.
   Allocate public Anycast only to the interceptor. Confirm `fly ips list` for
   the dialer is empty and its Machine config has no services or Flycast IP.
6. Set runtime values without displaying them. Confirm the private signing key
   is only in the application/runner and public verify keys are only in the
   gateway key set.
7. Deploy the private dialer first, then the public interceptor. Keep at least
   two running Machines for each app, with autostop disabled. Confirm actual
   placement meets the reviewed host/region failure model.
8. If dialer Machines or their 6PN addresses change, restart the interceptor
   fleet so startup can resolve, validate, firewall, and pin the new complete
   `.internal` answer set. Runtime target DNS remains pinned in `/etc/hosts`.

## Mandatory live gates before runner enablement

Static work here does not close any of these gates:

- Prove the Fly guest permits `nft` setup and capability removal, inspect the
  effective rules on both Machines, and demonstrate forbidden egress fails.
- Prove the dialer has no public/Flycast IP or service and only private 6PN
  TCP 9443 is listening; prove health is loopback-only.
- Prove public edge TLS rejects HTTP/2 ALPN and versions below TLS 1.2 while
  accepting HTTP/1.1 over TLS 1.2/1.3.
- Prove the exact pinned mitmproxy build interoperates with the Go CONNECT
  parser and mTLS identity, including two-dialer failure behavior.
- Prove both DoT operators, fixed bootstrap IPs, certificate names, privacy
  terms, and differing-answer fail-closed behavior.
- Prove Browserbase's paid plan supports the custom proxy and interception CA
  in the same project, and that WebRTC/STUN/TURN/UDP cannot escape the proxy.
- Prove signed credential expiry, audience mismatch, unknown/retired key IDs,
  and unapproved side-effect hosts fail closed in real sessions.
- Select and test a durable audit sink and retention policy. The current
  dedicated descriptor reaches the Fly log stream, but persistence and alerting
  are not established by this scaffold.
- Complete image-build reproducibility, SBOM, vulnerability scanning, external
  security review, controlled canaries, and seven consecutive stable scheduled
  days before any scheduler or runner flag is enabled.

Until those gates have current evidence, this is deployable scaffolding—not a
production-ready or live gateway.
