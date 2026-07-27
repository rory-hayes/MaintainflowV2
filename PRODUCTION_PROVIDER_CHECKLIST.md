# Production Provider Checklist

Provider configuration can break a perfect codebase. Verify every environment.

## Legal operator and launch contract

- [ ] Complete every applicable item in `docs/business-evals/LEGAL_RELEASE_INPUTS.md`; no operator, address, jurisdiction, controller, legal-basis, transfer, or complaint-route placeholder remains
- [ ] Qualified jurisdiction-appropriate review covers Terms, Privacy Policy, checkout acceptance, customer classification, DPA/subprocessors, and the actual provider/data flows
- [ ] After that review, the rendered Terms/Privacy dates, TypeScript version constants, `maintainflow_legal_acceptances_migration.sql` constants, and acceptance tests all match the exact reviewed documents
- [ ] Save the reviewed document versions and effective date with the exact release commit before public checkout or DNS cutover

## Domain

- [ ] Production domain resolves
- [ ] HTTPS works
- [ ] www redirects as intended
- [ ] No Vercel links in customer-facing UI

## Supabase

- [ ] Supabase Pro or higher is visibly active before `SUPABASE_PRODUCTION_PLAN_CONFIRMED=true`; automatic backups are available and inactivity pausing is disabled
- [ ] `NEXT_PUBLIC_SUPABASE_PROJECT_REF` exactly matches the production project URL; the only permitted Auth origins are that exact project or the verified `https://auth.maintainflow.io` custom domain
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` is the current `sb_publishable_` browser key and `SUPABASE_SERVICE_ROLE_KEY` is a distinct `sb_secret_` server key; no secret key appears in client bundles, logs, screenshots, or bearer headers
- [ ] For a new project, run `supabase/maintainflow_schema.sql`; for the existing production project, rehearse and deploy `MAINTAINFLOW_MIGRATION_PHASE=expand`, prove the compatible artifact live, then rehearse and redeploy with `MAINTAINFLOW_MIGRATION_PHASE=contract` for assurance integrity and paid-pilot retirement
- [ ] Confirm `maintainflow-reports` bucket exists and is private
- [ ] Confirm `maintainflow-eval-evidence` exists and is private; expired objects are removed through the Storage API before their rows are deleted
- [ ] Confirm authenticated users have no direct select, insert, update, or delete report-object policy; authorized PDF creation and download use the server-only service role after live evidence checks
- [ ] Site URL is exactly `https://www.maintainflow.io`
- [ ] Redirect URLs include the exact canonical and canary `/auth/callback`, `/auth/confirm`, and `/reset-password` URLs; no wildcard or unrelated origin is allowed
- [ ] Custom auth domain configured if hosted OAuth prompts must show Maintain Flow domain instead of the Supabase project ref
- [ ] Google OAuth provider configured
- [ ] Confirmation and password-reset subjects/bodies use the approved Maintain Flow templates
- [ ] SMTP sender displays `Maintain Flow` and uses a verified `@maintainflow.io` address
- [ ] Hosted password minimum is 6 characters, matching the app policy
- [ ] Email signup is enabled and email confirmation is required; signup never returns an immediate application session
- [ ] Confirm-signup email uses the exact allowlisted `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=email` link; `/auth/confirm` captures and scrubs the fragment, waits for a deliberate click, verifies through the same-origin server action, requires exact durable legal acceptance, globally revokes the temporary session, returns no browser session or token, works cross-device, and then requires password sign-in
- [ ] Password recovery uses `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=recovery`; it works cross-device, records exact current legal acceptance and changes the password only through the same-origin server action, globally revokes the temporary session, and returns no browser session or token. Google OAuth remains PKCE-bound. Invitation activation continues to accept only a typed invite link, capture and scrub its temporary credentials, require explicit password/legal action, revoke globally, and require sign-in
- [ ] Email click tracking and link rewriting are disabled for confirmation and recovery because each token hash remains a one-time bearer secret
- [ ] `SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED=true` is recorded only after that isolated hosted Google sign-in passes; Google client credentials remain in Supabase rather than Vercel
- [ ] Auth readiness attestations are set only after those hosted checks pass
- [ ] RLS enabled where required
- [ ] Storage buckets private where required
- [ ] Vault/encryption configured if used
- [ ] Cron configured if used

## Google OAuth

- [ ] Authorized JavaScript origins
- [ ] Authorized redirect URIs
- [ ] OAuth consent screen configured
- [ ] Branded Supabase callback URL added if `NEXT_PUBLIC_SUPABASE_AUTH_URL` is configured
- [ ] Production login tested

Do not claim provider readiness or set an attestation merely because the application code passes locally.

## Stripe

- [ ] Test products/prices configured
- [ ] Live products/prices configured
- [ ] Test webhook endpoint configured
- [ ] Live webhook endpoint configured
- [ ] Webhook secret in env
- [ ] Customer Portal configured
- [ ] Solo, Team, and Agency monthly and annual Price IDs are distinct and their Stripe amounts exactly match €49/€149/€399 monthly and €529.20/€1,609.20/€4,309.20 annual
- [ ] Selected-workspace canary uses test-mode Stripe keys, webhook and portal configuration; global launch uses separately verified live-mode values
- [ ] Success/cancel URLs use production domain
- [ ] Bounded low-value live transaction, signed webhook reconciliation, Customer Portal return, cancellation, and Free fallback are tested before public billing is called live

## Business email

- [ ] Workspace mailbox configured
- [ ] SPF configured
- [ ] DKIM configured
- [ ] DMARC configured
- [ ] Outbound email tested
- [ ] Inbound email tested
- [ ] Client-ready PDF can be attached and sent manually from the user's mailbox
- [ ] Dedicated Resend Inbound subdomain is verified and routes only to `/api/webhooks/resend/inbound`
- [ ] A real inbound canary traverses that subdomain at least every five minutes; verify the signed webhook retrieves content and writes a service-only `eval_email_receiving_health_events` row. Without this observation, a missing expected email is correctly `inconclusive`, not `failed`
- [ ] Signed inbound events are deduplicated, `EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64` is a separately managed 32-byte key, plaintext links/raw bodies are discarded, and inbound rows are service-only
- [ ] Controlled lead fixtures prove both routes: autoresponse to an opaque run address and destination-inbox forwarding to the owner/admin-only journey alias with an exact preserved run marker; wrong/missing/ambiguous markers are ignored
- [ ] Trial verification is autoresponse-only and opens only an owner-allowlisted HTTPS link
- [ ] The canonical public site is Business Evals; do not point production DNS at this release until `pnpm deploy:check` passes with the authenticated UI, runner, billing and providers enabled
- [ ] Outbound alert sender is verified and webhook delivery signatures/retries are smoke-tested
- [ ] Cleanup webhook JWKS is reachable, its key ID matches the configured Ed25519 private key, and a receiver verifies signature, timestamp and idempotent replay handling

## Browserbase

- [ ] Browserbase Developer or higher is visibly active before `BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED=true`; a real custom-proxy session is created successfully
- [ ] Review `docs/business-evals/BROWSERBASE_EGRESS_SECURITY_SPEC.md`; Browserbase is a release blocker until its gateway and Context-handoff canaries pass
- [ ] Production project and API key are configured
- [ ] `BROWSERBASE_PROJECT_ID` identifies the single reviewed production project; `BROWSERBASE_EGRESS_PROXY_SERVER` is a dedicated policy-enforcing public HTTPS origin on port 443; `BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID`, `BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64`, `BROWSERBASE_EGRESS_PROXY_AUDIENCE`, and `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID` are configured; configuration fails closed if any value is missing or unsafe
- [ ] Set explicit reviewed `BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT`, `BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT`, and `BROWSERBASE_USAGE_WARNING_PERCENT` values with in-flight headroom; prove the Project Usage API blocks session creation when unavailable or at either ceiling
- [ ] Review and set `BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS` and `BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES`; prove a non-terminal provider session enters the private retry ledger, blocks new sessions, resolves idempotently when terminal metadata arrives, and escalates only at the reviewed attempt or age boundary
- [ ] Prove request preflight and daily reconciliation contend on one usage-sampling lease: a second worker cannot call/persist out of order, an expired worker cannot write, and a replacement sample does not falsely trigger `provider_counter_decreased`
- [ ] Prove every eval and page scan writes a private creation intent before `sessions.create`, sends only its random opaque `mf_intent` metadata, registers the returned session ID before connection/use, and requests release while keeping the project paused if ledger registration fails
- [ ] Simulate crashes immediately before create, after create with a lost response, after create with the `uncertain` write unavailable, and after durable session registration. Prove a stale `prepared` intent is claimed only after 60 seconds, exact metadata lookup finds at most one same-project session, and active/pending scheduler leases cannot race the request poll
- [ ] Escalate both creation reconciliation and terminal metering to permanent error, then prove the service-only expected-attempt operator reopen is audited, replay-safe, and accepts late provider evidence through the normal idempotent path
- [ ] Accept the launch throughput contract: one shared Browserbase project serializes creation while any creation intent or active/pending session is unresolved. Size commercial headroom for one complete five-minute session plus its proxy allowance
- [ ] Resolve the Browserbase Project Usage API period/reset contract in writing or an approved operating procedure. The API returns totals but no billing-period identifier; any observed counter decrease deliberately blocks all new sessions until reconciled
- [ ] Confirm in writing whether Project Usage `proxyBytes` includes and bills traffic through Maintain Flow's customer-supplied external proxy; keep the byte ceiling as telemetry, not a claimed spend cap, until this is resolved
- [ ] Prove eval phases and page scans both create an immutable terminal session-usage row from Browserbase `startedAt`, `endedAt`, and `proxyBytes`, and that the daily scheduler stores a project usage snapshot
- [ ] Every Browserbase session receives a fresh short-lived signed credential (`mf1.<key ID>`, maximum 15-minute token); eval credentials use `run:<run UUID>` with the exact canonical owner-approved side-effect hosts, while a read-only scan credential uses `scan:<canonical target host>` with no side-effect hosts
- [ ] Every eval and page-scan session has approved hosts in Browserbase `allowedDomains`, exactly one authenticated external catch-all proxy rule (no domain pattern), and no direct, `none`, Browserbase residential/geolocation, or managed-proxy fallback; the proxy remains mandatory because `allowedDomains` covers only main-frame navigation
- [ ] The security proxy independently re-resolves and default-denies private, loopback, link-local, reserved and metadata destinations and mixed answers; it pins a permitted address per connection, caps response size and logs only safe audit metadata, never bodies or credentials
- [ ] The proxy either intercepts target TLS with a dedicated Browserbase-trusted CA or uses a documented equivalent provider/network control, so WSS, extended CONNECT, WebTransport and unknown tunnels remain blocked during every active short-lived session; a plain CONNECT tunnel is not sufficient
- [ ] The reviewed public CA is uploaded to the same Browserbase project, its opaque ID (not PEM content) is stored in `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID`, every eval and page-scan session supplies exactly that ID through `proxySettings.caCertificates`, `ignoreCertificateErrors` remains false, and the CA private key exists only in the gateway secret store
- [ ] A real session fails for a missing, deleted, or wrong-project certificate ID and succeeds only with the reviewed project/certificate pair; the public CA fingerprint and non-secret IDs are saved in the release packet
- [ ] Advanced stealth and CAPTCHA solving remain disabled, certificate verification remains enabled, and Browserbase session recording/logging remain disabled
- [ ] Browserbase metadata contains only the random opaque `mf_intent` correlation token. Raw run/workspace/Project/user IDs, URLs, emails, proxy credentials and connection URLs never enter provider metadata, application logs, durable Workflow state or evidence
- [ ] One private Context is created per eval run; every phase uses a new `keepAlive: false`, `context.persist: true` session; no live session remains during inbound-email waits; session use is sequential; and the Context is deleted after cleanup/finalization
- [ ] A service-role-only durable Context lease and bounded janitor delete abandoned Contexts; the dedicated route claims at most four contexts, runs at most four workers, gives each Browserbase call five seconds with zero SDK retries, and leaves provider retries to the durable database queue; a missing or stale restored Context makes the run inconclusive and never causes form/signup resubmission
- [ ] Cleanup-hook canary verifies the Ed25519 raw-body signature, signed timestamp/header equality, signed event-ID/idempotency equality, audience hash, timestamp tolerance and atomic duplicate suppression
- [ ] Public-target, redirect, rebinding, denylist and approved-domain canaries pass
- [ ] A production-identical controlled egress canary proves an allowed HTTPS request is prevalidated and then proxy-mediated, a cross-origin public subresource remains proxy-mediated, a disallowed popup is stopped by the context-wide navigation guard, a WebSocket handshake is rejected, and private/metadata/rebinding targets remain blocked
- [ ] A live custom-proxy canary proves the Browserbase SDK and gateway accept the full signed-token credential length; invalid signature, unknown key ID, wrong audience, expiry, and out-of-scope side effects all fail closed without exposing the token
- [ ] End the first session, prove Browserbase reports no live session during the simulated email wait, wait for Context synchronization, then repeat WebSocket, worker, timer-driven fetch and rebinding probes in a new session on the same Context; prove gateway outage cannot fall back to direct/provider-managed egress; save the proxy audit record, app result, deployed commit, image digest, CA fingerprint and proxy-policy fingerprint

## Vercel

- [ ] Vercel Pro or higher is visibly active before `VERCEL_COMMERCIAL_PLAN_CONFIRMED=true`; do not launch a paid SaaS from the non-commercial Hobby plan
- [ ] Production env vars correct
- [ ] Run `pnpm vercel:env:check` locally and confirm required key names are present
- [ ] Run `pnpm vercel:env:push` after `vercel login` only when the reviewed `.env.local` is the intended production source
- [ ] Preview and Development use separate environment-specific credentials; never copy production secrets with a bulk `--all` operation
- [ ] Canary fixture routes have a 32-character signing secret and verified sender, then return 404 again before global launch
- [ ] Build passes
- [ ] Runtime logs clean
- [ ] Landing and authenticated responses pass enforced CSP, anti-framing, nosniff, referrer, permissions, and HSTS header checks without browser violations
- [ ] Vercel Firewall rate-limits exact-path `POST /api/auth/email-action` before public launch; save a canary 429 without recording request bodies. The app also limits each source to 30 and each runtime to 300 attempts per five minutes, while Supabase remains the distributed provider backstop
- [ ] `CRON_SECRET`, `CHECK_RUNNER_BATCH_SIZE=5`, `CHECK_RUNNER_LEASE_SECONDS=180`, and `BROWSER_CONTEXT_CLEANUP_BATCH_SIZE=4` configured
- [ ] `/api/cron/run-checks` rejects unauthenticated requests
- [ ] `/api/cron/run-evals`, `/api/cron/cleanup-browser-contexts`, and `/api/cron/deliver-eval-alerts` reject unauthenticated requests
- [ ] Supabase scheduler SQL has been run
- [ ] `supabase/maintainflow_scheduler_verify.sql` returns expected extensions, RPC, lease columns, and cron job
- [ ] Supabase `maintainflow-run-checks` and `maintainflow-run-checks-2` jobs are active every minute with a 60-second transport timeout
- [ ] Supabase `maintainflow-run-evals` is active; quota exhaustion blocks new run creation without advancing the schedule
- [ ] Supabase `maintainflow-cleanup-browser-contexts` is the only cleanup job, is active every minute, targets the dedicated cleanup route with `batchSize=4`, and retains the 60-second transport timeout without modifying `maintainflow-run-evals`
- [ ] `pnpm smoke:cron` proves both cron routes reject unsigned requests and, with the reviewed secret, the cleanup route returns only bounded aggregate counts
- [ ] Runner and scheduler kill switches are tested before enabling the Business Evals UI flag
- [ ] `RUN_LOG_KEY_PEPPER` is a separately managed secret of at least 32 random characters before rate-limit audit events are written
- [ ] Scheduled job creates `check_runs`, `issues`, and `check_job_runs` from due checks
- [ ] `/contact-sales` and legacy campaign routes redirect to `/sign-up`; retired contact-sales and retry APIs return `410`; `/assurance` remains absent

## Sentry

- [ ] Sentry ingest DSN, organisation slug, project slug, and secret source-map upload token are configured in Production
- [ ] A controlled client render error appears with user, request payload, email, token, and query data redacted
- [ ] A controlled server request error appears with the same redaction boundary
- [ ] Source maps resolve both controlled stack traces to the exact reviewed release commit
