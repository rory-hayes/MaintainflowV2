# Architecture — Business Evals

Maintain Flow remains a modular monolith for the control plane, with isolated workers for untrusted browser execution. This document describes the target architecture; it is not deployment evidence.

## Runtime boundaries

- **Web control plane:** Next.js/TypeScript on Vercel for authentication, projects, journeys, run requests, evidence views, billing, and delivery configuration.
- **System of record:** Supabase Auth, Postgres, Row Level Security, private Storage, and audit data.
- **Queue/dispatcher:** durable run requests, quotas, priority, leases, cancellation, retries, and dead-letter/terminal states.
- **Browser workers:** short-lived isolated browser contexts with no service credentials, per-request public-target validation, service-worker/WebSocket blocking, per-run storage, and strict time/resource limits. Local fixture traffic is public-IP pinned by the worker. Production Browserbase traffic continues only after that validation and must traverse one per-session-authenticated catch-all external security proxy that independently blocks DNS rebinding/private destinations; there is no direct or managed-proxy fallback.
- **Browser commercial control:** before each production Browserbase session, one shared sampling lease must serialize the provider Project Usage API response and it must return current `browserMinutes` and `proxyBytes` below explicit internal ceilings. A private creation intent precedes the non-idempotent create, the returned session ID is registered before connection/use, and only an opaque random correlation token enters provider metadata. Lost create responses are reconciled through exact metadata lookup; terminal provider timestamps and `proxyBytes` are stored once per eval phase or page scan. Creation/metering faults, stale writes, decreasing counters, and over-limit usage block new sessions. Launch intentionally allows only one unresolved session lifecycle per shared Browserbase project.
- **Legacy endpoint runner:** the existing SSRF-controlled public HTTPS GET path, exposed as a legacy journey adapter.
- **Delivery workers:** email, webhook, live-link, and PDF publication from immutable evidence snapshots.
- **Billing:** Stripe-hosted Checkout and Customer Portal, a private workspace-wide Checkout reservation ledger, signed webhooks, authenticated exact-Session return reconciliation, server-derived entitlements, and explicit contract-version migration.

The browser worker must not run inside a public request handler or share a tenant session, service-role key, browser profile, download directory, cookie jar, or network namespace with another run. Each eval run owns one encrypted Browserbase Context and opens a new `keepAlive: false` session for each browser phase. At that session boundary the server mints a fresh Ed25519-signed Basic credential lasting no more than 15 minutes. Eval credentials use the stable subject `run:<run UUID>` and carry the exact canonical owner-approved side-effect hosts; read-only page scans use `scan:<canonical target host>` with an empty side-effect list. The session ends before an inbound-email wait; the next sequential phase starts only after the bounded Context synchronization delay. Browserbase connection URLs exist only long enough for the provider adapter to connect, and proxy tokens exist only long enough to create that session. Durable workflow state contains only opaque Context/last-session IDs, an approved origin-plus-path resume URL, and a readiness timestamp—never a connection URL, proxy credential, cookie, or serialized browser storage. Provider recording and logging are disabled because raw provider-side artifacts sit outside the sanitized evidence contract.

## Product domains

- workspaces, memberships, roles, and seats
- projects and approved domains
- journeys, immutable versions, steps, and assertions
- run requests, attempts, leases, and verdicts
- browser, email, and legacy endpoint evidence
- delivery snapshots and artifacts
- plans, quotas, retention, trials, subscriptions, and migration versions
- exact Terms/Privacy versions and server-recorded legal acceptances; new email users fail closed without exact metadata, OAuth acceptance is persisted after authentication, and new memberships require a current row except for a trusted pending Supabase invitation that must accept before password activation
- attestations, audit events, abuse signals, and operational incidents

Schema support does not make a capability deployable. Each domain requires authorization, persistence, service behavior, and acceptance evidence.

## Run state machine

```text
queued -> claimed -> running -> evaluating -> passed | failed | inconclusive | cancelled
                      \-> retry_wait -> queued
                      \-> dead_letter/inconclusive
```

- Claim with a bounded lease and idempotency key.
- Count a run against quota when a worker first claims it; replaying an identical delivery event must not double-count.
- Use separate attempt records for retries. Never overwrite original evidence.
- Retry only transient runner/infrastructure failures with capped exponential backoff and jitter.
- Do not retry deterministic business assertion failures automatically.
- Expired leases return safely to the queue only when the idempotency/attempt policy permits it.
- Workspace and global concurrency caps protect target systems and platform capacity.

## Browser journey execution

1. Authenticate the caller and load tenant-scoped project/journey data.
2. Verify the project domain authorization and current attestation.
3. Freeze the exact journey version and create an idempotent run request.
4. Dispatcher enforces plan quota, workspace concurrency, domain rate limits, and worker capacity.
5. Worker creates or restores the run's private Browserbase Context, then mints a fresh signed proxy credential, writes a private tenant-bound creation intent, and starts one short-lived session for the current phase with `keepAlive: false`, `context.persist: true`, the opaque intent token in `userMetadata.mf_intent`, and the approved hosts in `allowedDomains`. The returned session ID is committed to the active metering ledger before its connection URL or Context is used. The credential's side-effect scope is the exact canonical owner-approved host set. The authenticated catch-all external egress proxy and reviewed public CA certificate-ID must both validate; the ID is supplied as the sole `proxySettings.caCertificates` entry and certificate errors are never ignored. `allowedDomains` is only a top-level guard, so every routed request is still re-resolved and policy-checked in-process before it continues through that proxy; local fixtures instead use the already validated public IP. Direct, `none`, or Browserbase-managed proxy egress is rejected.
6. Each step records timing, safe URL/origin, action type, and redacted before/after evidence where allowed.
7. Email-verification steps wait on a signed Resend hook within a bounded window. Autoresponses must target the opaque run address. Destination-mailbox notifications must be forwarded to the HMAC-authenticated stable journey alias and preserve the exact submitted run marker.
8. Deterministic assertion code evaluates typed observations.
9. The service persists attempt evidence and the terminal verdict atomically.
10. Delivery jobs publish an immutable redacted snapshot according to entitlement.

CAPTCHA, MFA, unexpected authentication, download prompts, payment controls, domain escapes, or human-approval gates stop the run as inconclusive. The runner must not attempt bypass or outsource solving.

## Deterministic assertion contract

Supported assertions are versioned, typed, and evaluated without an LLM. Initial browser assertions may cover:

- expected origin/path after navigation;
- element visible/hidden/enabled;
- exact or normalized bounded text;
- native/browser validation state;
- confirmation state containing the unique test marker;
- correlated email arrival and allowlisted sender/subject/link properties.

An assertion records expected rule, safe observed value or digest, result, timestamp, and evaluator version. Required assertion results alone determine `pass` or `fail`; inability to obtain a valid observation is `inconclusive`.

## AI-assist boundary

AI operates after safe input reduction. It may suggest a draft journey, translate user intent into supported assertion types, label screenshots, cluster similar failures, or draft an explanation. AI output is advisory, versioned, and separately identified. It cannot execute arbitrary code, receive secrets, change authorization, mutate a saved journey without confirmation, modify assertion results, or set the verdict.

The server exposes two bounded Responses API operations: a journey-configuration draft and a diagnosis for an already-finalized `failed` or `inconclusive` run. Both use strict Structured Outputs, tenant-scoped authorization, hashed persistent idempotency, shared database rate limits, redacted/minimized inputs, `store: false`, and terminal audit events. The service stores only the request hash, safe structured draft, provider identifiers and token counts—never the raw prompt context. A journey suggestion remains tied to its base draft revision and can enter the deterministic journey only through the ordinary explicit Save and Publish controls.

## Evidence architecture

- Store metadata and assertion records in tenant-scoped Postgres rows.
- Store screenshots and PDFs in private object paths scoped to workspace/project/run.
- Redact configured selectors, secrets, tokens, cookies, query values, and personal data before persistence.
- Screenshot capture applies a cross-frame and shadow-root redaction stylesheet, masks every direct text/media/form/custom-element channel plus configured locators and generated values, and fails closed if that redaction pass cannot complete. Only successful/degraded screenshots produced by this pass can be marked report-safe.
- Failed and inconclusive browser stages may attach a real Playwright trace archive. Traces are private, unredacted diagnostic artifacts; they are never selected into report snapshots or served through public share links.
- Never store raw browser profiles, unrestricted HAR files, email bodies, or response bodies by default.
- Build live links/PDFs from immutable evidence snapshots, not current mutable journey state.
- Authorize every retrieval; signed URLs are short lived and scoped to one artifact.
- Enforce plan retention asynchronously and idempotently; legal/security/billing audit records may have separate documented retention.

## Email verification

Autoresponse proof uses an opaque run-scoped recipient. Forwarded destination-inbox proof uses an HMAC-authenticated stable journey alias exposed only to owners/admins and accepts a message only when exactly one active run's marker appears intact in its safe subject/text content. Trial verification remains autoresponse-only. Sanitize HTML, never load remote content or attachments, follow only explicitly allowlisted HTTPS verification links, and persist only safe hashes/metadata plus an AES-256-GCM ciphertext bound to the workspace, run and event. The durable hook carries only the inbound event identifier and safe timestamp; the workflow decrypts the link inside a service-only step. Inbound email records are service-only; raw bodies and plaintext verification links are discarded after matching. Each email assertion has an approved target threshold and a final maximum wait: arrival by the target passes, arrival after the target but by the maximum is degraded, and arrival after the maximum fails. A separate service-only receiving-health event is written only after a signed Resend `email.received` webhook for the exact inbound domain successfully retrieves message content. When no correlated email arrives by the maximum, failure is allowed only when one of those real observations covers that final deadline within the fixed five-minute freshness window; no observation, a stale observation, or an unreadable health store produces `inconclusive`, never a guessed provider-health claim.

## Legacy endpoint adapter

The existing public HTTPS GET runner remains isolated behind its current saved-monitor and SSRF policy. A legacy endpoint journey keeps its original check/run identity and service provenance. Migration may add project/journey references, but must not fabricate browser steps, replace historical IDs, or promote `legacy_browser` records into trusted service evidence.

## Billing compatibility

The persisted enum remains `free | starter | growth | scale | agency_plus` during the reversible transition. Business Evals maps those IDs to Free, Solo, Team, and Agency only after `business_evals_v1` is explicitly recorded for the workspace. Missing contract version means an active paid subscription is grandfathered and receives its legacy plan object.

The card-free Team trial is a workspace entitlement, not a Stripe subscription. Its original expiry remains the one-trial marker. Checkout must not create another trial. Before the new prices are enabled, Stripe products, checkout metadata, webhook mapping, Customer Portal, database limits, and public copy must all be reconciled and tested.

## Deployment and rollback

Roll out additively by workspace cohort:

1. land contract/version-aware code and read-only compatibility;
2. land schema and service APIs;
3. provision queue, isolated workers, mailbox, storage, and monitoring;
4. run synthetic and authorized canaries;
5. enable internal/test workspaces;
6. enable new workspaces and the Team trial;
7. offer explicit legacy subscription migration;
8. remove compatibility paths only after evidence and notice.

Rollback disables browser scheduling/intake, drains or cancels queued work safely, revokes delivery links if required, and restores the prior UI/API path. It does not delete Business Evals or legacy data, rewrite subscriptions, or mislabel incomplete runs. Detailed steps are in `docs/business-evals/LEGACY_MIGRATION.md`.

## Provider setup outside the repository

Production requires verified Supabase migrations/RLS/storage, queue and worker capacity, browser runtime isolation, inbound email configuration, outbound email sender, Stripe products/webhooks/portal, Vercel environment variables, DNS, secrets, alerting, backups, retention jobs, and exact-commit deployment proof. Code or documentation alone is not production readiness.
