# Environment Variables Example

Do not commit real secrets.

```txt
NEXT_PUBLIC_APP_URL=https://www.maintainflow.io
NEXT_PUBLIC_SITE_URL=https://www.maintainflow.io
VERCEL_TEAM_SLUG=rorys-projects-accf0d71
VERCEL_PROJECT_ID=prj_zbbXA1ZH26G9YAL8sNtEkxHy1AwE
# For the selected-workspace canary only, use https://maintainflow-v2.vercel.app
# for both public URL values. Restore the canonical www origin before launch.

# Local QA
# Set to local when you need browser-only auth/data while real Supabase keys remain in .env.local.
NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE=

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
# Optional branded Supabase Auth base URL, for example https://auth.maintainflow.io.
# Keep NEXT_PUBLIC_SUPABASE_URL on the Supabase project URL for REST and Storage.
NEXT_PUBLIC_SUPABASE_AUTH_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
DATABASE_URL=
# First compatible deployment: expand. Change Production to contract only after
# that artifact is live and the contract dry run passes.
MAINTAINFLOW_MIGRATION_PHASE=expand

# Supabase Auth deployment attestations. These do not configure the provider.
# Set them only after the hosted sender, templates, redirects, and policy are verified.
SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED=false
SUPABASE_AUTH_SMTP_CONFIRMED=false
SUPABASE_AUTH_SMTP_SENDER=
SUPABASE_AUTH_REDIRECTS_CONFIRMED=false
SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED=false
SUPABASE_AUTH_PASSWORD_MIN_LENGTH=6

# Production-plan attestations. These do not upgrade a provider.
# Set true only after the paid plan is visibly active in that provider.
SUPABASE_PRODUCTION_PLAN_CONFIRMED=false
VERCEL_COMMERCIAL_PLAN_CONFIRMED=false
BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED=false

# Auth / OAuth
# These are Supabase dashboard configuration inputs, not Vercel runtime keys.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Email/password auth is always available alongside Google SSO.

# Stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_SOLO=
STRIPE_PRICE_TEAM=
STRIPE_PRICE_AGENCY=
STRIPE_PRICE_SOLO_ANNUAL=
STRIPE_PRICE_TEAM_ANNUAL=
STRIPE_PRICE_AGENCY_ANNUAL=
# Existing subscriptions only. These IDs are never used for new Business Evals checkout.
STRIPE_LEGACY_PRICE_STARTER=
STRIPE_LEGACY_PRICE_GROWTH=
STRIPE_LEGACY_PRICE_SCALE=
STRIPE_LEGACY_PRICE_STARTER_ANNUAL=
STRIPE_LEGACY_PRICE_GROWTH_ANNUAL=
STRIPE_LEGACY_PRICE_SCALE_ANNUAL=
STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID=
STRIPE_CUSTOMER_PORTAL_ENABLED=false
# Settings checkout needs STRIPE_SECRET_KEY and the exact reusable Solo/Team/Agency Price value.
# All three monthly and annual Prices are required because the public pricing page offers both intervals.
# The one-time 14-day Team trial is card-free and is never restarted by Stripe checkout.
# Configure the Stripe webhook endpoint at /api/billing/webhook and set STRIPE_WEBHOOK_SECRET.
# Customer portal remains disabled until an exact test/live portal configuration ID is verified and webhook/customer sync stores a tenant-scoped Stripe customer ID.

# Sentry
NEXT_PUBLIC_SENTRY_DSN=
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_PROJECT=

# Encryption / secrets
APP_ENCRYPTION_KEY=
# Required in production; use at least 32 random characters so stored
# rate-limit key hashes cannot be correlated from raw identifiers.
RUN_LOG_KEY_PEPPER=
REPORT_SHARE_TOKEN_PEPPER=
ALERT_ENDPOINT_ENCRYPTION_KEY=
EVAL_EMAIL_ROUTING_SECRET=
# Base64 for exactly 32 random bytes. Verification links are AES-256-GCM
# encrypted at rest and bound to their workspace, eval run and inbound event.
EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64=
# Base64-encoded DER PKCS#8 Ed25519 private key; publish only the derived JWKS endpoint.
EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64=
EVAL_CLEANUP_SIGNING_KEY_ID=

# Jobs
CHECK_RUNNER_SECRET=
CRON_SECRET=
# Each of the two minute scheduler workers runs one bounded five-check wave.
CHECK_RUNNER_BATCH_SIZE=5
CHECK_RUNNER_LEASE_SECONDS=180
BUSINESS_EVALS_SCHEDULER_BATCH_SIZE=5
BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS=300
ALERT_DELIVERY_BATCH_SIZE=10

# Business Evals production providers
OPENAI_API_KEY=
# Optional override is intentionally allowlisted to the approved launch model.
BUSINESS_EVALS_AI_MODEL=gpt-5.6-sol
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
# Required for every Browserbase-backed eval and page scan. This must be the
# dedicated policy-enforcing HTTPS egress proxy origin, with credentials kept in
# separate variables. Browserbase managed proxies and direct fallback are forbidden.
BROWSERBASE_EGRESS_PROXY_SERVER=https://egress-proxy.example.com:443
BROWSERBASE_EGRESS_PROXY_USERNAME=
BROWSERBASE_EGRESS_PROXY_PASSWORD=
RESEND_API_KEY=
RESEND_INBOUND_WEBHOOK_SECRET=
EVAL_INBOUND_DOMAIN=inbound.maintainflow.io
# The same domain receives opaque per-run autoresponses and HMAC-authenticated
# stable journey aliases used by customer-owned destination forwarding rules.
# Optional address domain for browser-only lead evals. Defaults to example.invalid.
EVAL_SYNTHETIC_EMAIL_DOMAIN=
MAINTAINFLOW_ALERT_FROM_EMAIL=
BUSINESS_EVALS_DOMAIN_DENYLIST=
# Controlled runner canaries. Production fixture routes remain 404 until this
# explicit flag is enabled. The sender must be verified in Resend, and the
# signing secret must contain at least 32 random characters.
BUSINESS_EVALS_FIXTURES_ENABLED=false
BUSINESS_EVALS_FIXTURE_FROM_EMAIL=
BUSINESS_EVALS_FIXTURE_SIGNING_SECRET=

# Internal ops monitor
# Route is /control-room/<MAINTAINFLOW_OPS_ROUTE_KEY>; API access also requires this email allowlist.
MAINTAINFLOW_OPS_ROUTE_KEY=
OPS_ADMIN_EMAILS=

# Feature flags
NEXT_PUBLIC_BUSINESS_EVALS_UI=false
# Comma-separated workspace UUIDs for internal/selected-workspace rollout while
# the global UI flag remains false.
BUSINESS_EVALS_WORKSPACE_ALLOWLIST=
BUSINESS_EVALS_RUNNER_ENABLED=false
BUSINESS_EVALS_RUNNER_KILL_SWITCH=true
BUSINESS_EVALS_SCHEDULER_KILL_SWITCH=true
ENABLE_SLACK_ALERTS=false
ENABLE_POSTHOG=false
ENABLE_PRIVATE_ENDPOINTS=false
```

Provider-side setup must be verified manually:

- Supabase Auth URLs
- Google OAuth redirect URLs
- Stripe live/test webhook endpoints
- Vercel environment variables
- DNS
