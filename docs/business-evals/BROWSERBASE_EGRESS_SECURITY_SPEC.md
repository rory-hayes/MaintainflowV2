# Browserbase production egress security decision

Status: **release blocker; external policy gateway required**

This decision applies to production Browserbase eval and page-scan sessions. It does not change the local fixture runner.

## Decision

Maintain Flow cannot currently obtain a production-grade SSRF, DNS-rebinding, and unattended WebSocket boundary from the Browserbase/Playwright controls plus the repository allowlists alone. Production must retain one authenticated, catch-all external HTTP(S) proxy rule and must not fall back to direct or Browserbase-managed proxy egress.

This is deliberately a fail-closed decision. No environment, provider, or live deployment was changed as part of this audit. The runner remains not production-ready until the gateway below is provisioned and every acceptance canary passes.

## Why the in-process controls are not the security boundary

| Control | What it does | Why it is insufficient alone |
| --- | --- | --- |
| Maintain Flow `allowedHosts` and request guard | Re-resolves HTTPS requests while Playwright is connected; requires project authorization for top-level navigations and side-effecting requests; rejects address changes seen during a run | It is an application/controller control and cannot independently enforce the provider's connection-time DNS decision during an active session. |
| Browserbase `allowedDomains` | Restricts main-frame navigation to listed domains and subdomains | Browserbase's official SDK contract says it does not block iframe/subframe navigations or in-page requests such as images, scripts, and XHR. It therefore cannot protect subresource or worker egress. |
| Playwright `browserContext.route()` | Intercepts matching HTTP requests in a connected context | Playwright documents Service Worker caveats and recommends `serviceWorkers: "block"` for interception. The current Browserbase adapter receives the provider-created default context rather than creating one with that option. Updated Service Worker main-script requests also have a documented routing limitation. |
| Playwright `routeWebSocket()` | Rejects WebSockets created after the handler is installed | The handler is controller-bound and does not make an ordinary CONNECT tunnel capable of distinguishing encrypted HTTPS from WSS during an active session. |
| Browserbase managed proxies | Provide managed network identity and geolocation | Browserbase does not document them as a private/reserved-address, DNS-rebinding, or unsupported-protocol security boundary. Its documentation points to custom HTTP/HTTPS proxies for custom security policy and routing control. |

Maintain Flow does not use that long-session lifecycle. One encrypted Browserbase Context is scoped to one eval run, and every phase opens a new session with `keepAlive: false` and `context.persist: true`. The session is ended before the workflow waits for inbound email; after Browserbase's bounded Context synchronization delay, the next phase opens a fresh sequential session. A private durable lease prevents concurrent Context use and a bounded janitor deletes abandoned Contexts. Contexts can persist cookies, local storage, IndexedDB, Service Workers, cache, and preferences, so every new active session still requires the same network boundary. `offline` emulation, page monkey-patching, and a best-effort domain list are not substitutes for that policy.

Official references:

- [Browserbase custom proxies and trusted CA certificates](https://docs.browserbase.com/platform/identity/proxies)
- [Browserbase keep-alive lifecycle](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive)
- [Browserbase Context lifecycle](https://docs.browserbase.com/platform/browser/core-features/contexts)
- [Browserbase SDK 2.16.0 `allowedDomains` contract](https://github.com/browserbase/sdk-node/blob/v2.16.0/src/resources/sessions/sessions.ts)
- [Playwright context routing and Service Worker caveat](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)
- [Playwright WebSocket routing lifecycle](https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket)
- [Playwright Service Worker routing limitation](https://playwright.dev/docs/service-workers#known-limitations)

## Required gateway contract

The gateway is a security component, not a generic scraping proxy. Its reviewed policy version and image digest must be recorded with each release canary.

### Listener and authentication

- Expose one public HTTPS proxy origin on port 443. Plain HTTP, SOCKS, transparent proxying, admin ports, and unauthenticated listeners are forbidden.
- Require a fresh Ed25519-signed Basic credential over TLS for every Browserbase session. The username is `mf1.<key ID>` and the password is the bounded signed token. Verify the trusted key ID, signature, audience, `nbf`/`iat`/`exp` (maximum 15 minutes), stable subject, random `jti`, and canonical side-effect-host claim before policy evaluation; strip `Proxy-Authorization` before forwarding. Static shared passwords are forbidden.
- Eval credentials use `run:<run UUID>` and include exactly the canonical owner-approved hosts where mutation-class requests may occur. A read-only scan credential uses `scan:<canonical target host>` with an empty side-effect-host list. Read-only requests still receive ordinary destination/SSRF enforcement; a mutation-class request to a host absent from the signed claim is rejected.
- Accept only standard HTTP proxy requests and `CONNECT` to destination port 443. Reject IP-literal authorities, user-info, malformed or non-normalized hosts, non-HTTPS destinations, arbitrary TCP, CONNECT-UDP, HTTP/3, and every unapproved protocol upgrade.
- Limit source access to Browserbase egress ranges if Browserbase supplies stable current ranges. Authentication and policy enforcement remain mandatory even when an IP allowlist is present.

### DNS and destination policy

- Normalize hostnames to lower-case ASCII/IDNA, remove a single trailing dot, enforce DNS label limits, and reject ambiguous encodings before resolution.
- Resolve A and AAAA records inside the gateway immediately before each new upstream connection. If **any** returned address is private, loopback, link-local, multicast, unspecified, reserved, documentation-only, benchmarking, carrier-grade NAT, metadata, or otherwise special-purpose, reject the entire destination; do not select a public answer from a mixed set.
- Default-deny every block in the current [IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) and [IANA IPv6 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml), including mapped/translated forms, unless a separately reviewed product exception exists. No launch exception is approved.
- Independently deny cloud metadata hostnames and addresses, the configured Maintain Flow domain denylist, proxy-local names, Fly private names/addresses, and resolver search-domain expansion.
- Pin the selected public address for that connection while preserving the original hostname for TLS SNI and certificate verification. Re-resolve every redirect/new connection. A DNS answer change from public to blocked must fail closed.
- Never retain a previously public cached address after a response that is wholly blocked. This is important because Envoy's documented `resolved_address_filter` otherwise removes blocked answers while permitting a cache to retain a prior result. The implementation must invalidate/expire that host or deny it at an additional connection filter when a blocked answer appears.

Envoy's dynamic forward proxy is a suitable DNS/connection policy building block because it exposes `resolved_address_filter` specifically for SSRF/rebinding protection, TLS SNI/SAN verification, circuit breakers, and request limits. Its stock filter is **not sufficient by itself** for this contract: it removes matching addresses instead of rejecting a mixed answer, and it may retain a previously cached public address when every new answer is removed. Use a reviewed all-answer validator/custom typed resolver plus connection-time enforcement, with `resolved_address_filter` as a second backstop. Envoy also warns that an untrusted dynamic forward proxy needs firewall and default-deny restrictions; an unfiltered example configuration is not acceptable.

- [Envoy dynamic forward proxy security warning](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/dynamic_forward_proxy_filter)
- [Envoy DNS cache `resolved_address_filter`](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/common/dynamic_forward_proxy/v3/dns_cache.proto.html)
- [Envoy CONNECT and upgrade controls](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/upgrades.html)

### HTTPS and WebSocket policy

A normal CONNECT proxy can see `hostname:443`, but it cannot distinguish encrypted HTTPS from `wss://` after the tunnel is established. During every active short-lived session, the gateway must use one of these reviewed mechanisms:

1. **Preferred:** terminate/intercept target TLS with a dedicated private CA, inspect HTTP/1.1 and HTTP/2, and reject WebSocket Upgrade, extended CONNECT, WebTransport, and unknown protocol tunnels before upstream connection; or
2. a Browserbase-provided, documented provider/network control that independently rejects those protocols for the full active-session lifetime and is proven by the same Context-handoff canaries.

Browserbase officially supports uploading a private proxy CA and installing it in a session with `proxySettings.caCertificates`. Use that mechanism; keep `ignoreCertificateErrors: false`. The CA private key exists only in the gateway secret store, never in Maintain Flow, Browserbase, Vercel, workflow state, or logs. The Browserbase certificate record contains only the public CA certificate.

The application adapter requires `BROWSERBASE_EGRESS_PROXY_SERVER`, `BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID`, `BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64`, `BROWSERBASE_EGRESS_PROXY_AUDIENCE`, and one `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID`. It mints credentials only at session creation and supplies the certificate ID as the sole `proxySettings.caCertificates` entry for every Browserbase eval and page-scan session. Missing or structurally unsafe values fail before session creation, and Browserbase rejects an unknown or wrong-project ID when the session is created. Neither tokens nor the signing private key enter errors, logs, workflow handles, evidence, or Browserbase metadata. This wiring is not evidence that a gateway or CA has been provisioned: the runner remains blocked until the reviewed public CA is uploaded to the intended Browserbase project, its fingerprint and lifecycle are approved, and the live canaries pass.

### Resource and privacy limits

- No automatic retries for `POST`, signup, form submission, WebSocket/upgrade attempts, or uncertain tunnels.
- Enforce a five-second DNS/connect timeout, a 30-second request/response idle timeout, a 20 MiB response ceiling, a 64 KiB header ceiling, bounded request bodies, and per-credential/destination concurrency and rate limits. Abort rather than truncate a response used as evidence.
- Verify upstream TLS chains, hostname/SAN, SNI, validity, and minimum TLS policy. Never use an ignore-certificate-errors mode.
- Disable raw TCP and UDP forwarding. Do not expose a DNS resolver, cache UI, traffic inspector, replay endpoint, or provider admin endpoint publicly.
- Do not persist request/response bodies, query strings, cookies, headers, submitted values, certificates, credentials, or raw URLs. Safe audit fields are: timestamp, policy version, hashed normalized host, destination address class, method class, allowed/blocked result, reason code, latency, bounded byte counts, and a random gateway event ID.
- Health checks must exercise only a local health endpoint; they must never create an arbitrary outbound request.

## Practical deployment route

Keep the gateway implementation in the approved V2 repository under a future isolated `infra/browser-egress-proxy/` service; do not create another product repository. A practical small-team route is:

1. Build a pinned, minimal gateway image that combines an HTTP(S) TLS-interception layer with a policy dialer. The interception layer authenticates Browserbase, strips sensitive headers, rejects WebSocket/extended CONNECT and enforces body/header limits. The dialer owns all-answer DNS validation, per-connection IP pinning and upstream TLS. Envoy may supply that egress layer only with the custom all-answer resolver/validator described above; its stock address filter remains a backstop. Neither layer may have a direct bypass around the other.
2. Deploy it as a dedicated Fly app in the region nearest Browserbase `eu-central-1`, with two always-on Machines, no autostop, a public TLS service on 443 only, rolling updates, TCP/HTTP health checks, bounded memory/CPU, and automatic routing away from unhealthy Machines. Fly documents raw TCP/TLS services, health checks, multiple-Machine availability, and encrypted runtime secrets.
3. Put the proxy verification public keys and CA private key only in the gateway's encrypted secret store. Put the matching proxy-signing private key only in Vercel's production secret store. Issue a dedicated public hostname and certificate. Keep the Envoy/admin listener on loopback or a private Unix socket and deny it at the Fly service definition.
4. Upload the public CA certificate to the Browserbase project. After review, configure its certificate ID through `proxySettings.caCertificates` and the existing catch-all external proxy rule. Do not disable normal certificate validation.
5. Configure `BROWSERBASE_EGRESS_PROXY_SERVER`, `BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID`, `BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64`, `BROWSERBASE_EGRESS_PROXY_AUDIENCE`, and `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID` in Vercel only after the deployed gateway passes the tests below. The certificate ID is an opaque public Browserbase record ID; never configure PEM content or the CA private key in Vercel.
6. Record the gateway image digest, policy fingerprint, CA certificate fingerprint, Browserbase project, app commit, Fly release, and canary evidence in the release packet.

Fly references:

- [Fly services and TLS/TCP handlers](https://fly.io/docs/networking/services/)
- [Fly health checks](https://fly.io/docs/reference/health-checks/)
- [Fly app availability](https://fly.io/docs/apps/app-availability/)
- [Fly runtime secrets](https://fly.io/docs/apps/secrets/)

A managed secure-web-gateway product is an acceptable substitute only if it exposes an authenticated HTTPS forward-proxy endpoint compatible with Browserbase and contractually/documentedly provides the same address filtering, rebinding behavior, TLS inspection, no-body logging, protocol denial, limits, audit fields, and high-availability evidence. A residential proxy, scraping proxy, VPN IP, or geolocation product is not an acceptable substitute.

## Acceptance canaries

Run the following against the exact production image, policy, Browserbase project/region, and certificate configuration. Each forbidden case must fail closed at the gateway and produce a safe audit reason without a request reaching the destination.

- allowed public HTTPS main-frame, same-origin asset, and cross-origin public subresource;
- public-to-public redirect, with a fresh policy decision for the new host;
- private, loopback, link-local, metadata, reserved, multicast, IPv4-mapped IPv6, NAT64/special, IP-literal, mixed public/private DNS, and public-to-private rebinding targets;
- top-level navigation, iframe, popup, form POST, fetch/XHR, image/script, worker, and Service Worker update requests aimed at a blocked destination;
- `ws://`, `wss://`, HTTP/1.1 Upgrade, HTTP/2 extended CONNECT, WebTransport/HTTP3, raw CONNECT to non-443, CONNECT-UDP, and a WebRTC/STUN/TURN leak probe;
- end the first `keepAlive: false` session, prove no live browser remains during a simulated email wait, wait for bounded Context synchronization, then repeat the WebSocket, worker, timer-driven fetch, and rebinding probes in a new session using the same Context;
- invalid proxy signature, unknown key ID, wrong audience, not-yet-valid/expired token, overlong credential, an eval side effect outside its signed exact host set, any side effect under a read-only scan credential, invalid/expired upstream certificate, hostname mismatch, proxy certificate not trusted, oversized headers/body, slow DNS/connect/response, concurrency exhaustion, and total gateway outage;
- prove the Browserbase SDK, its session API, and the gateway accept the maximum real signed-token credential length before clearing the live-provider blocker;
- verify no direct/provider-managed fallback by making the external gateway unavailable and proving the browser cannot reach an allowed public canary;
- verify audit output contains only the approved metadata fields and that provider/application logs contain no proxy credentials, CA key, Browserbase connection URL, raw target URL, body, cookie, or synthetic value.

Do not mark Browserbase production-ready until all canaries pass on seven consecutive scheduled canary days. A failed or missing result keeps the runner/UI cutover flag off; the scheduler kill switch remains the immediate rollback control.

## Follow-on implementation boundary

The app-side CA-ID/Context wiring and structural readiness validation do not add a proxy service, upload a certificate, or mutate any live environment. The separately reviewed security-infrastructure slice must still deliver the gateway image, policy tests, public CA upload and lifecycle, Context-handoff/no-live-session canaries, operating runbook, and key/CA rotation procedure. It must not loosen the existing application-side checks; the two layers are intentionally independent.
