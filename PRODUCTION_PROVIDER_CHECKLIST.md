# Production Provider Checklist

Provider configuration can break a perfect codebase. Verify every environment.

## Domain

- [ ] Production domain resolves
- [ ] HTTPS works
- [ ] www redirects as intended
- [ ] No Vercel links in customer-facing UI

## Supabase

- [ ] Supabase Pro or higher is visibly active before `SUPABASE_PRODUCTION_PLAN_CONFIRMED=true`; automatic backups are available and inactivity pausing is disabled
- [ ] For a new project, run `supabase/maintainflow_schema.sql`; for the existing production project, rehearse and deploy `MAINTAINFLOW_MIGRATION_PHASE=expand`, prove the compatible artifact live, then rehearse and redeploy with `MAINTAINFLOW_MIGRATION_PHASE=contract` for assurance integrity and paid-pilot retirement
- [ ] Confirm `maintainflow-reports` bucket exists and is private
- [ ] Confirm `maintainflow-eval-evidence` exists and is private; expired objects are removed through the Storage API before their rows are deleted
- [ ] Confirm authenticated users have no direct select, insert, update, or delete report-object policy; authorized PDF creation and download use the server-only service role after live evidence checks
- [ ] Site URL is exactly `https://www.maintainflow.io`
- [ ] Redirect URLs include `https://www.maintainflow.io/auth/callback` and `https://www.maintainflow.io/reset-password`
- [ ] Custom auth domain configured if hosted OAuth prompts must show Maintain Flow domain instead of the Supabase project ref
- [ ] Google OAuth provider configured
- [ ] Confirmation and password-reset subjects/bodies use the approved Maintain Flow templates
- [ ] SMTP sender displays `Maintain Flow` and uses a verified `@maintainflow.io` address
- [ ] Hosted password minimum is 6 characters, matching the app policy
- [ ] Auth confirmation, recovery, and Google OAuth pass with an isolated account
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
- [ ] Review `docs/business-evals/BROWSERBASE_EGRESS_SECURITY_SPEC.md`; Browserbase is a release blocker until its gateway and disconnected-session canaries pass
- [ ] Production project and API key are configured
- [ ] `BROWSERBASE_EGRESS_PROXY_SERVER` is a dedicated policy-enforcing HTTPS origin, with separately stored username/password; configuration fails closed if any value is missing or unsafe
- [ ] Every eval and page-scan session has exactly one authenticated external catch-all proxy rule (no domain pattern) and no direct, `none`, Browserbase residential/geolocation, or managed-proxy fallback
- [ ] The security proxy independently re-resolves and default-denies private, loopback, link-local, reserved and metadata destinations and mixed answers; it pins a permitted address per connection, caps response size and logs only safe audit metadata, never bodies or credentials
- [ ] The proxy either intercepts target TLS with a dedicated Browserbase-trusted CA or uses a documented equivalent provider/network control, so WSS, extended CONNECT, WebTransport and unknown tunnels remain blocked while the keep-alive browser is disconnected; a plain CONNECT tunnel is not sufficient
- [ ] When TLS interception is used, the Browserbase session supplies the reviewed public CA ID through `proxySettings.caCertificates`, `ignoreCertificateErrors` remains false, and the CA private key exists only in the gateway secret store
- [ ] Advanced stealth and CAPTCHA solving remain disabled, certificate verification remains enabled, and Browserbase session recording/logging remain disabled
- [ ] Raw run IDs, proxy credentials and Browserbase connection URLs never enter provider metadata, application logs, durable Workflow state or evidence
- [ ] Managed sessions reconnect across the inbound-email wait and are released after cleanup
- [ ] Cleanup-hook canary verifies the Ed25519 raw-body signature, signed timestamp/header equality, signed event-ID/idempotency equality, audience hash, timestamp tolerance and atomic duplicate suppression
- [ ] Public-target, redirect, rebinding, denylist and approved-domain canaries pass
- [ ] A production-identical controlled egress canary proves an allowed HTTPS request is prevalidated and then proxy-mediated, a cross-origin public subresource remains proxy-mediated, a disallowed popup is stopped by the context-wide navigation guard, a WebSocket handshake is rejected, and private/metadata/rebinding targets remain blocked
- [ ] Repeat WebSocket, worker, timer-driven fetch and rebinding probes after Playwright disconnects while the Browserbase keep-alive session remains active; prove gateway outage cannot fall back to direct/provider-managed egress; save the proxy audit record, app result, deployed commit, image digest, CA fingerprint and proxy-policy fingerprint

## Vercel

- [ ] Vercel Pro or higher is visibly active before `VERCEL_COMMERCIAL_PLAN_CONFIRMED=true`; do not launch a paid SaaS from the non-commercial Hobby plan
- [ ] Production env vars correct
- [ ] Run `pnpm vercel:env:check` locally and confirm required key names are present
- [ ] Run `pnpm vercel:env:push` after `vercel login` only when the reviewed `.env.local` is the intended production source
- [ ] Preview and Development use separate environment-specific credentials; never copy production secrets with a bulk `--all` operation
- [ ] Canary fixture routes have a 32-character signing secret and verified sender, then return 404 again before global launch
- [ ] Build passes
- [ ] Runtime logs clean
- [ ] Landing response passes CSP report-only, anti-framing, nosniff, referrer, permissions, and HSTS header checks
- [ ] `CRON_SECRET`, `CHECK_RUNNER_BATCH_SIZE=5`, and `CHECK_RUNNER_LEASE_SECONDS=180` configured
- [ ] `/api/cron/run-checks` rejects unauthenticated requests
- [ ] `/api/cron/run-evals` and `/api/cron/deliver-eval-alerts` reject unauthenticated requests
- [ ] Supabase scheduler SQL has been run
- [ ] `supabase/maintainflow_scheduler_verify.sql` returns expected extensions, RPC, lease columns, and cron job
- [ ] Supabase `maintainflow-run-checks` and `maintainflow-run-checks-2` jobs are active every minute with a 60-second transport timeout
- [ ] Supabase `maintainflow-run-evals` is active; quota exhaustion blocks new run creation without advancing the schedule
- [ ] Runner and scheduler kill switches are tested before enabling the Business Evals UI flag
- [ ] `RUN_LOG_KEY_PEPPER` is a separately managed secret of at least 32 random characters before rate-limit audit events are written
- [ ] Scheduled job creates `check_runs`, `issues`, and `check_job_runs` from due checks
- [ ] `/contact-sales` and legacy campaign routes redirect to `/sign-up`; retired contact-sales and retry APIs return `410`; `/assurance` remains absent

## Sentry

- [ ] DSN configured
- [ ] Client errors captured
- [ ] Server errors captured
- [ ] Source maps configured if needed
