# Vercel Dashboard Environment Setup

Use this when the Vercel CLI/device-code login is failing.

Dashboard path:

```txt
Vercel -> maintainflow-v2 -> Settings -> Environment Variables
```

Likely direct URL:

```txt
https://vercel.com/rorys-projects-accf0d71/maintainflow-v2/settings/environment-variables
```

`maintainflow-v2` is the explicit superseding V2 target. The former `maintainflow` project is legacy release history: do not add V2 values there, delete it, or detach the public domain until the reviewed V2 cutover is verified and separately approved.

Only use `.env.local` when it has been explicitly reviewed as the intended **Production** source. Do not paste secrets into chat, docs, commits, or screenshots.

## Scope

Add the reviewed keys to **Production only**. Preview and Development must use separate test projects and environment-specific credentials; never copy Production secrets into those environments.

After saving or changing values, trigger a new production deployment so Vercel rebuilds with the latest environment.

## Required

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PROJECT_REF`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL`

Use the current `sb_publishable_` public key and `sb_secret_` server key. The
project reference must exactly match `https://<project-ref>.supabase.co`; the
release checks reject swapped keys, legacy keys, mismatched tenants, and custom
Auth origins other than the verified `https://auth.maintainflow.io` origin.

- `SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED`
- `SUPABASE_AUTH_SMTP_CONFIRMED`
- `SUPABASE_AUTH_SMTP_SENDER`
- `SUPABASE_AUTH_REDIRECTS_CONFIRMED`
- `SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED`
- `SUPABASE_AUTH_PASSWORD_MIN_LENGTH`
- `CRON_SECRET`
- `CHECK_RUNNER_BATCH_SIZE`
  - Production value: `5`.
- `CHECK_RUNNER_LEASE_SECONDS`
  - Production value: `180`.
- `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`
  - Required for production client/server/edge error capture and source-map upload.
  - The DSN and slugs are non-secret; the organization token is secret and Production-only.
  - Do not enable Session Replay or default PII collection. Verify the repository redaction boundary with controlled client and server errors after deployment.

## Legacy Stripe reconciliation variables

- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_SCALE`
- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_GROWTH_ANNUAL`
- `STRIPE_PRICE_SCALE_ANNUAL`

These old names are compatibility fallbacks only. Prefer the explicit variables below for existing subscriptions, and never place new Business Evals Prices in either legacy set:

- `STRIPE_LEGACY_PRICE_STARTER`
- `STRIPE_LEGACY_PRICE_GROWTH`
- `STRIPE_LEGACY_PRICE_SCALE`
- `STRIPE_LEGACY_PRICE_STARTER_ANNUAL`
- `STRIPE_LEGACY_PRICE_GROWTH_ANNUAL`
- `STRIPE_LEGACY_PRICE_SCALE_ANNUAL`

Self-serve billing requires this complete, same-mode set before the selected-workspace canary or global launch:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_SOLO`
- `STRIPE_PRICE_TEAM`
- `STRIPE_PRICE_AGENCY`
- `STRIPE_PRICE_SOLO_ANNUAL`
- `STRIPE_PRICE_TEAM_ANNUAL`
- `STRIPE_PRICE_AGENCY_ANNUAL`
- `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID` (the matching verified `bpc_...` configuration ID for the current canary or launch stage)
- `STRIPE_CUSTOMER_PORTAL_ENABLED=true` (only after that portal configuration is active and verified)

The six Price IDs must be distinct. Missing any item keeps `/api/billing/status` at `checkoutConfigured=false`; presence still requires separate Stripe-side amount, interval, webhook, portal, and entitlement canaries.

## Stage-specific and optional values

- `MAINTAINFLOW_OPS_ROUTE_KEY` and `OPS_ADMIN_EMAILS`
  - Optional internal control-room access. If either is omitted, do not treat the control room as an available production monitor.

- `MAINTAINFLOW_MIGRATION_PHASE`
  - Omit it or set `expand` for the first compatible production deployment; `expand` is the default.
  - Set it to `contract` in Production only after that artifact is live and the rollback-only contract rehearsal passes.

Keep the production Customer Portal values scoped to Production. The selected-workspace canary uses its test-mode configuration; replace it with the separately verified live configuration before global launch. Preview and Development must use their own test-mode portal configuration IDs and Stripe keys if portal testing is enabled there; never copy the live configuration ID into those environments.

- `NEXT_PUBLIC_SUPABASE_AUTH_URL`
  - Only set this after a Supabase custom auth domain is configured.
  - Without it, hosted OAuth prompts may still show the Supabase project domain.

The six `SUPABASE_AUTH_*` values are non-secret attestations, not provider configuration. Set them only after the hosted sender, templates, redirects, Google sign-in, and password policy pass the approval checklist. Google client credentials stay in the Supabase provider dashboard and are not copied to Vercel.

The three provider-plan attestations also configure nothing. Set `SUPABASE_PRODUCTION_PLAN_CONFIRMED=true` only after Supabase Pro or higher is active, `VERCEL_COMMERCIAL_PLAN_CONFIRMED=true` only after Vercel Pro or higher is active, and `BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED=true` only after Browserbase Developer or higher can create custom-proxy sessions. Free Supabase can pause and has no automatic backups; Vercel Hobby is not a commercial production plan.

## Business Evals cutover

Keep the authenticated UI and runner flags off until the migration, Browserbase, Resend inbound, private storage, billing and canary smoke tests pass. Use `BUSINESS_EVALS_WORKSPACE_ALLOWLIST` for internal and selected-workspace cohorts while the global UI flag remains false. The canonical public site already uses Business Evals positioning, so production DNS must not point at the release until `pnpm deploy:check` passes. Before enabling selected workspaces, configure:

- `SUPABASE_PRODUCTION_PLAN_CONFIRMED=true`
- `VERCEL_COMMERCIAL_PLAN_CONFIRMED=true`
- `BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED=true`
- `OPENAI_API_KEY`
- `BUSINESS_EVALS_AI_MODEL=gpt-5.6-sol` (optional; this is the server default)
- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`
- `BROWSERBASE_EGRESS_PROXY_SERVER`
- `BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID`
- `BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64`
- `BROWSERBASE_EGRESS_PROXY_AUDIENCE`
- `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID`
- `BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT`
- `BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT`
- `BROWSERBASE_USAGE_WARNING_PERCENT=80`
- `BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS=12`
- `BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES=60`
- `RESEND_API_KEY`
- `RESEND_INBOUND_WEBHOOK_SECRET`
- `EVAL_INBOUND_DOMAIN`
- `EVAL_EMAIL_ROUTING_SECRET`
- `EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64`
- `EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64`
- `EVAL_CLEANUP_SIGNING_KEY_ID`
- `REPORT_SHARE_TOKEN_PEPPER`
- `RUN_LOG_KEY_PEPPER`
- `ALERT_ENDPOINT_ENCRYPTION_KEY`
- `MAINTAINFLOW_ALERT_FROM_EMAIL`
- `BUSINESS_EVALS_FIXTURE_FROM_EMAIL`
- `BUSINESS_EVALS_FIXTURE_SIGNING_SECRET`
- `BUSINESS_EVALS_SCHEDULER_BATCH_SIZE=5`
- `BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS=300`
- `BROWSER_CONTEXT_CLEANUP_BATCH_SIZE=4` (default 4; runtime clamps the value to 1-4 contexts per cron pass)
- `ALERT_DELIVERY_BATCH_SIZE=10`
- `NEXT_PUBLIC_SENTRY_DSN`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`
- `BUSINESS_EVALS_RUNNER_ENABLED=true`
- `BUSINESS_EVALS_RUNNER_KILL_SWITCH=false`
- `BUSINESS_EVALS_SCHEDULER_KILL_SWITCH=false`

For the selected-workspace canary use test-mode Stripe credentials, `NEXT_PUBLIC_BUSINESS_EVALS_UI=false`, a non-empty `BUSINESS_EVALS_WORKSPACE_ALLOWLIST`, and `BUSINESS_EVALS_FIXTURES_ENABLED=true` only during the bounded fixture canary. For global launch replace Stripe with the verified live-mode key, Prices, webhook secret, and portal configuration; use `NEXT_PUBLIC_BUSINESS_EVALS_UI=true`, clear the allowlist, and set `BUSINESS_EVALS_FIXTURES_ENABLED=false` so fixture routes return 404.

`BUSINESS_EVALS_DOMAIN_DENYLIST` and `EVAL_SYNTHETIC_EMAIL_DOMAIN` are optional hardening/configuration inputs. Turning either kill switch on is the immediate rollback control.

The Browserbase proxy values are mandatory for both eval sessions and page scans whenever a selected-workspace allowlist or global Business Evals runner/UI cutover is enabled. `BROWSERBASE_PROJECT_ID` must identify the single reviewed production project. The server value must be a credential-free HTTPS origin on port 443 with a public DNS hostname. Each session receives a new short-lived Ed25519-signed Basic credential; static usernames and passwords are retired, and a real provider canary must prove Browserbase accepts the complete signed credential length. `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID` is the opaque ID of the reviewed public CA certificate uploaded to that same Browserbase project; it is not the PEM certificate or private key. Production binds the project ID and certificate ID to every session, supplies the certificate as the sole `proxySettings.caCertificates` entry, and accepts only the dedicated external catch-all security proxy, never Browserbase managed/residential/geolocation proxying or direct/`none` fallback. Missing or malformed project, proxy, or CA configuration blocks the environment push and runtime session creation.

The Browserbase minute and byte ceilings are internal commercial circuit breakers, not customer quotas. Pick explicit values below the maximum payable amount with headroom for bounded sessions already in flight. The runtime samples Browserbase Project Usage before every new provider session, blocks on unavailable/over-limit metering, records terminal session timestamps and `proxyBytes`, and performs a claimed daily reconciliation. Browserbase does not expose a billing-period/reset identifier in that API; a decreasing counter blocks the runner until the external contract or reviewed re-baseline procedure is resolved.

## Do Not Add Unless Needed

These are present locally for setup/reference but are not required by the current Vercel runtime:

- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_ID`
- `NEXT_PUBLIC_SUPABASE_REST_URL`

## Verification

Once the dashboard values are saved and a new production deployment is live, run:

```bash
pnpm deploy:check
```

Then verify live:

```bash
curl -I https://www.maintainflow.io/
```

`/api/billing/status` is intentionally authenticated and tenant-scoped, so an unauthenticated `curl` correctly returns `401` and is not billing evidence. Sign in as an owner or administrator, select the intended workspace, open `/settings/billing`, and verify the authenticated status request in the browser. The response must keep `checkoutConfigured=false` until the matching server secret, webhook signing secret, six distinct public Price IDs, and enabled Customer Portal configuration are all present. Provider-side Stripe test/live canaries are still required; a `true` configuration flag proves presence, not correctness.
