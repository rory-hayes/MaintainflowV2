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
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL`
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

New checkout requires:

- `STRIPE_PRICE_SOLO`
- `STRIPE_PRICE_TEAM`
- `STRIPE_PRICE_AGENCY`

## Stage-specific and optional values

- `MAINTAINFLOW_OPS_ROUTE_KEY` and `OPS_ADMIN_EMAILS`
  - Optional internal control-room access. If either is omitted, do not treat the control room as an available production monitor.

- `MAINTAINFLOW_MIGRATION_PHASE`
  - Omit it or set `expand` for the first compatible production deployment; `expand` is the default.
  - Set it to `contract` in Production only after that artifact is live and the rollback-only contract rehearsal passes.

- `STRIPE_PRICE_SOLO_ANNUAL`
- `STRIPE_PRICE_TEAM_ANNUAL`
- `STRIPE_PRICE_AGENCY_ANNUAL`
- `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID` (the matching verified `bpc_...` configuration ID for the current canary or launch stage; Production only)
- `STRIPE_CUSTOMER_PORTAL_ENABLED` (`true` only after the portal configuration is active and verified)
  - Solo, Team, and Agency monthly and annual Stripe Prices are all required because the public pricing page offers both intervals.

Keep both Customer Portal activation keys scoped to Production. The selected-workspace canary uses its test-mode configuration; replace it with the separately verified live configuration before global launch. Preview and Development must use their own test-mode portal configuration IDs and Stripe keys if portal testing is enabled there; never copy the live configuration ID into those environments.

- `NEXT_PUBLIC_SUPABASE_AUTH_URL`
  - Only set this after a Supabase custom auth domain is configured.
  - Without it, hosted OAuth prompts may still show the Supabase project domain.

The six `SUPABASE_AUTH_*` values are non-secret attestations, not provider configuration. Set them only after the hosted sender, templates, redirects, Google sign-in, and password policy pass the approval checklist. Google client credentials stay in the Supabase provider dashboard and are not copied to Vercel.

The three provider-plan attestations also configure nothing. Set `SUPABASE_PRODUCTION_PLAN_CONFIRMED=true` only after Supabase Pro or higher is active, `VERCEL_COMMERCIAL_PLAN_CONFIRMED=true` only after Vercel Pro or higher is active, and `BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED=true` only after Browserbase Developer or higher can create custom-proxy sessions. Free Supabase can pause and has no automatic backups; Vercel Hobby is not a commercial production plan.
- `NEXT_PUBLIC_SENTRY_DSN`

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
- `BROWSERBASE_EGRESS_PROXY_USERNAME`
- `BROWSERBASE_EGRESS_PROXY_PASSWORD`
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
- `ALERT_DELIVERY_BATCH_SIZE=10`
- `BUSINESS_EVALS_RUNNER_ENABLED=true`
- `BUSINESS_EVALS_RUNNER_KILL_SWITCH=false`
- `BUSINESS_EVALS_SCHEDULER_KILL_SWITCH=false`

For the selected-workspace canary use test-mode Stripe credentials, `NEXT_PUBLIC_BUSINESS_EVALS_UI=false`, a non-empty `BUSINESS_EVALS_WORKSPACE_ALLOWLIST`, and `BUSINESS_EVALS_FIXTURES_ENABLED=true` only during the bounded fixture canary. For global launch replace Stripe with the verified live-mode key, Prices, webhook secret, and portal configuration; use `NEXT_PUBLIC_BUSINESS_EVALS_UI=true`, clear the allowlist, and set `BUSINESS_EVALS_FIXTURES_ENABLED=false` so fixture routes return 404.

`BUSINESS_EVALS_DOMAIN_DENYLIST` and `EVAL_SYNTHETIC_EMAIL_DOMAIN` are optional hardening/configuration inputs. Turning either kill switch on is the immediate rollback control.

The Browserbase proxy values are mandatory for both eval sessions and page scans whenever a selected-workspace allowlist or global Business Evals runner/UI cutover is enabled. The server value must be a credential-free HTTPS origin on a public DNS hostname; credentials use the separate variables. Production accepts only the dedicated external catch-all security proxy, never Browserbase managed/residential/geolocation proxying or direct/`none` fallback.

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
curl https://www.maintainflow.io/api/billing/status
```
