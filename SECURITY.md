# Security — Business Evals

Maintain Flow executes customer-configured browser and endpoint journeys, receives verification email, stores evidence, and publishes private artifacts. Every input and target is untrusted until the service establishes tenant scope, authorization, and policy compliance.

This is the target security contract, not a claim that the Business Evals runner is deployed or independently certified.

## Tenant isolation

Every protected resource belongs to one workspace and project. Enforce isolation with:

- Supabase Row Level Security and explicit workspace/project filters;
- server-side membership and role checks;
- service-role access limited to server/worker paths that retain tenant scope;
- unique private object paths and authorized artifact retrieval;
- clean browser contexts, cookie jars, mail aliases, and working directories per run;
- tests that attempt cross-tenant reads, writes, object access, queue claims, and live-link use.

Frontend visibility, opaque IDs, and signed URLs are not substitutes for authorization.

## Domain authorization and attestation

A journey cannot run until the workspace owner:

1. identifies the target domains and allowed subdomains;
2. attests that the workspace owns them or has explicit permission to test them;
3. confirms the journey is non-destructive and safe at the configured frequency; and
4. accepts responsibility for test data, third-party charges, and required cleanup.

Higher-risk or disputed targets may require DNS/file verification or operator review. Attestations are versioned, attributable, revocable, and rechecked before scheduling. Redirects and form actions may not escape the approved domain set except for narrowly allowlisted identity/email-provider flows.

## Browser execution controls

- Run each attempt in an ephemeral isolated browser context without platform service credentials.
- Route every Browserbase request through the authenticated, policy-enforcing external security proxy; there is no direct, `none`, or Browserbase-managed fallback.
- Restrict network egress to approved public origins and required platform services.
- Block localhost, loopback, private, link-local, metadata, reserved, literal-IP, and policy-denied destinations.
- Re-resolve and revalidate every navigation, redirect, popup, frame, resource fetch, and form action relevant to the journey.
- Apply per-workspace, per-domain, and global concurrency/rate limits.
- Bound pages, steps, redirects, execution time, response size, uploads/downloads, CPU, memory, and retained evidence.
- Disable arbitrary scripts, extensions, browser profiles, uncontrolled downloads, and customer-supplied executable code.
- Disable Browserbase advanced stealth, CAPTCHA solving, provider recording, and provider logging; keep certificate verification enabled and connection URLs ephemeral inside the provider adapter.
- Stop on CAPTCHA, MFA, anti-bot challenge, payment UI, unexpected privileged authentication, or destructive confirmation.

Maintain Flow does not solve or bypass CAPTCHA, MFA, access controls, anti-bot systems, or rate limits. CAPTCHA behavior is `inconclusive` with an evidence-safe reason, not a failed business verdict.

## SSRF and URL safety

Legacy endpoint journeys retain the existing public-HTTPS GET and DNS-pinning policy. While the Playwright controller is connected, Chromium HTTP requests are intercepted; non-HTTPS schemes are rejected; and HTTPS targets are normalized, resolved, and checked for mixed/private/loopback/link-local/metadata addresses. Redirects return to the interceptor and are independently revalidated. Local fixtures are fetched through the validated public IP with TLS SNI pinned to the original hostname. Production Browserbase requests continue only after the same check and then traverse the dedicated external proxy, whose connection-time DNS policy closes the validation-to-connection rebinding window. The connected context bypasses Service Workers and blocks WebSockets; the external gateway remains authoritative across Browserbase keep-alive disconnects.

Every Browserbase eval and page-scan session must contain exactly one authenticated external proxy rule with no domain pattern, making it the catch-all connection boundary after the in-process request check. The context-wide Playwright guard enforces approved top-level/form-action destinations and covers popups; read-only public subresources may load through the proxy. The proxy must default-deny private/reserved/metadata destinations and mixed DNS answers, repeat public-HTTPS/DNS policy at connection time, pin the permitted address per connection, cap response size, and emit only safe audit metadata. Because an ordinary CONNECT tunnel cannot distinguish HTTPS from encrypted WSS, the gateway must use a Browserbase-trusted interception CA or a documented equivalent persistent provider/network control to deny WebSocket and other unsupported upgrades throughout keep-alive disconnects. Browserbase residential/geolocation proxies, `none` rules, and direct fallback are forbidden. DNS changes, oversized responses, unsupported schemes, proxy failure, missing proxy configuration, and certificate errors fail closed. Provider recordings/logs are disabled and raw run IDs are not sent as Browserbase metadata. Do not persist proxy credentials or connection URLs in workflow state, URLs, request bodies, headers, logs, screenshots, or evidence. The exact release contract is `docs/business-evals/BROWSERBASE_EGRESS_SECURITY_SPEC.md`.

## Verdict and evidence trust boundary

Only service-issued runs over immutable journey versions become trusted evidence. Browser previews, local mocks, client-submitted status, AI output, and legacy browser-written runs cannot set health or verdicts.

- Required deterministic assertions alone produce `passed`, `degraded`, or `failed`; `not_run` is reserved for unreached stages.
- Runner, access, policy, queue, email-provider, persistence, and evidence failures are `inconclusive`.
- An explicitly stopped run is `cancelled`.
- Every retry has its own attempt and evidence.
- Screenshots are captured only after a cross-frame and shadow-root redaction pass masks text, media, form values, custom elements, configured locators, synthetic values, and CSS/pseudo-element content. Capture fails closed if that pass cannot complete; report sharing additionally requires the service-issued `redacted` and `report_safe` bindings.
- Playwright trace archives are retained only for failed or inconclusive diagnosis, remain private and explicitly unredacted, and are never eligible for public reports.
- Evidence records include evaluator/runner version and provenance.
- Live links and PDFs use immutable snapshots and tenant-scoped authorization.
- Expired evidence is removed according to plan retention without silently deleting required billing/security audit records.

## Email verification safety

Do not connect to a customer's general inbox. Autoresponses must arrive at the opaque run-scoped address. A customer may instead configure a destination-inbox forwarding rule to the HMAC-authenticated journey alias; only workspace owners and admins may retrieve that unguessable alias, and that route is accepted only when the forwarded content preserves the exact synthetic run marker and matches exactly one active run. Trial verification cannot use forwarding because its allowlisted verification link must bind to the generated test identity. Sanitize received HTML, block external content, never execute attachments, and never follow non-allowlisted links. Persist only safe sender/recipient/subject/timestamp/link hashes plus an AES-256-GCM ciphertext for an allowlisted verification URL, bound to the workspace, run and inbound event. The inbound event table is service-only. Raw bodies and plaintext links are discarded after matching. Receiving health also remains service-only and is observed only after a signed Resend event for the exact inbound domain successfully retrieves content; it stores only a provider-event hash, domain, provider, and server timestamp. A missing, stale, or unreadable health observation is `inconclusive`. A provider incident must not be presented as proof that the customer's email failed.

Customer-owned cleanup hooks are signed with the platform Ed25519 key. Receivers verify the exact `timestamp + "." + raw body` bytes using `/.well-known/maintainflow-cleanup-jwks.json` before parsing the body. They must then require the timestamp header to equal the signed `issuedAt`, require `Idempotency-Key` to equal the signed `eventId`, recompute the signed `audience` as `sha256:` plus the SHA-256 of the configured target URL after standard URL normalization and fragment removal, and enforce a short timestamp tolerance. The receiver must atomically claim the signed `eventId` before performing cleanup and return its stored result for duplicates. This makes the stable event ID, intended endpoint and timestamp part of the authenticated envelope instead of trusting replayable headers. The private key is never shared with a workspace and a key ID supports controlled rotation.

## Secrets and personal data

- Prefer public/test-mode journeys that need no customer credential.
- Never put secrets or full personal data into AI prompts, logs, screenshots, URLs, support references, or shared artifacts.
- Redact passwords, tokens, cookies, payment data, and configured selectors before storage.
- Encrypt approved secrets with separate key access and audit before enabling authenticated journeys; this capability is deferred from the initial contract.
- Use synthetic, uniquely marked test data and provide cleanup instructions.

## AI-assist controls

AI may receive only the redacted, minimum context needed for an advisory task. It cannot browse independently, execute arbitrary code, alter authorization, approve a journey, set/rewrite a verdict, or invent evidence. Store model/provider/version and the user confirmation that converted any suggestion into a saved deterministic rule. Customer data must not be used to train shared models unless a separate explicit contract permits it.

## Billing and retention security

Stripe-hosted surfaces own payment entry. Webhooks require signature verification, an atomic event-ID and payload-fingerprint receipt, claim-token finalization, customer/workspace mapping, and current subscription retrieval where needed. Raw Stripe webhook bodies are discarded after processing. Browser users cannot write plan, trial, contract version, Stripe linkage, or complimentary entitlement.

One card-free Team trial is granted per workspace and its original expiry must remain an auditable marker. Existing paid subscriptions default to the legacy contract until an explicit migration version is recorded. Plan downgrades never delete customer records immediately; they block new over-limit activity and apply documented evidence retention/export behavior.

## Prohibited uses

No unauthorized targets, destructive testing, penetration testing, vulnerability scanning, spam, uncontrolled messages, real purchases, fraudulent accounts, credential stuffing, scraping unrelated third parties, malware, unlawful content, compliance certification, or evasion of plan/runner controls.

## Production readiness

Before enabling browser journeys, verify tenant isolation, target authorization, SSRF/navigation policy, worker isolation, queue leases/idempotency/concurrency, CAPTCHA stops, email correlation, deterministic verdicts, evidence redaction/storage/retention, billing contract versioning, abuse response, monitoring, backups, rollback, provider configuration, and the exact deployed commit. A passing local build is not launch proof.
