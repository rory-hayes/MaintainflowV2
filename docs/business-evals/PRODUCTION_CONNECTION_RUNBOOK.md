# Business Evals production connection runbook

This is the final provider-and-domain sequence. The application is deliberately fail-closed: neither the canary environment nor the global launch is considered ready until the matching readiness command passes.

## 1. Prove the local release candidate

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm test:business-evals:database
pnpm build
```

Do not continue from an older green run after changing the source or environment.

## 2. Connect Supabase

1. Create or select the production project.
2. Apply `supabase/maintainflow_schema.sql` for a new project. For an existing project, follow the documented expand/contract migration sequence.
3. Create private `maintainflow-reports` and `maintainflow-eval-evidence` buckets and verify that authenticated users cannot read or mutate objects directly.
4. Keep the Supabase Site URL canonical at `https://www.maintainflow.io`. Allowlist these exact application redirects before attesting redirects:
   - `https://www.maintainflow.io/auth/callback`
   - `https://www.maintainflow.io/reset-password`
   - `https://maintainflow-v2.vercel.app/auth/callback`
   - `https://maintainflow-v2.vercel.app/reset-password`
   The V2 entries are required for confirmation, recovery and Google OAuth during the isolated canary; do not replace the canonical Site URL with the canary origin.
5. Configure the verified Maintain Flow SMTP sender and approved confirmation/reset templates.
6. Record the Supabase Auth readiness variables, including `SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED=true`, only after isolated confirmation, recovery and Google OAuth tests pass. Google client credentials stay in Supabase and are not copied to Vercel.

## 3. Connect the execution and email providers

1. Create the Browserbase production project and connect its dedicated policy-enforcing HTTPS egress proxy. Direct, managed residential and CAPTCHA-solving fallbacks stay disabled.
2. Configure Resend outbound sending and a dedicated inbound subdomain routed only to `/api/webhooks/resend/inbound`.
3. Generate separate high-entropy secrets for inbound routing, verification-link encryption, report links, rate-limit key hashing and alert endpoints. `RUN_LOG_KEY_PEPPER` must contain at least 32 random characters.
4. Generate a PKCS#8 Ed25519 cleanup-signing key and publish only its derived JWKS public key.
5. Verify the alert sender and controlled inbound canary before treating a missing expected email as conclusive.

## 4. Connect Stripe

Create stable Solo, Team and Agency Prices for both monthly and annual billing. The annual totals must be €529.20, €1,609.20 and €4,309.20. Configure the webhook and Customer Portal, then add the exact **test-mode** secret, Price, webhook and portal configuration IDs to the reviewed canary `.env.local`. Existing Price IDs remain only in `STRIPE_LEGACY_PRICE_*` variables and are never reused for new checkout.

## 5. Stage a selected-workspace canary

Use a production-owned canary workspace while the global UI remains off:

```txt
NEXT_PUBLIC_APP_URL=https://maintainflow-v2.vercel.app
NEXT_PUBLIC_SITE_URL=https://maintainflow-v2.vercel.app
NEXT_PUBLIC_BUSINESS_EVALS_UI=false
BUSINESS_EVALS_WORKSPACE_ALLOWLIST=<canary-workspace-uuid>
BUSINESS_EVALS_RUNNER_ENABLED=true
BUSINESS_EVALS_RUNNER_KILL_SWITCH=false
BUSINESS_EVALS_SCHEDULER_KILL_SWITCH=false
BUSINESS_EVALS_FIXTURES_ENABLED=true
BUSINESS_EVALS_FIXTURE_FROM_EMAIL=<verified-maintainflow-sender>
BUSINESS_EVALS_FIXTURE_SIGNING_SECRET=<at-least-32-random-characters>
```

Then run:

```sh
pnpm deploy:check:canary
pnpm vercel:env:check:canary
pnpm vercel:env:push:canary
```

Deploy to the production Vercel project without moving public DNS. First run `pnpm smoke:canary` and require an unauthenticated application response on the stable `https://maintainflow-v2.vercel.app` production domain, including reachable Resend and Stripe webhook routes that reject unsigned requests. Do not use a protected unique deployment URL for provider callbacks. Then prove both controlled templates, inbound email, verification-link allowlisting, required cleanup, a scheduled run, an Incident recovery, a PDF, an expiring/revocable share link, outbound alerts and Stripe test checkout/portal. Keep the scheduler kill switch available throughout.

## 6. Open the global release

After the canary evidence is saved, replace every Stripe test-mode value with its verified live-mode counterpart. Then:

```txt
NEXT_PUBLIC_APP_URL=https://www.maintainflow.io
NEXT_PUBLIC_SITE_URL=https://www.maintainflow.io
NEXT_PUBLIC_BUSINESS_EVALS_UI=true
BUSINESS_EVALS_WORKSPACE_ALLOWLIST=
BUSINESS_EVALS_FIXTURES_ENABLED=false
```

Keep the runner and scheduler enabled with both kill switches false, then run:

```sh
pnpm deploy:check
pnpm vercel:env:check
pnpm vercel:env:push
```

The launch push updates existing production values in place and removes the canary workspace allowlist and fixture-only secrets. Do not treat an existing Vercel variable as success unless its reviewed launch value was actually written.

Deploy the exact verified commit. Before DNS moves, run the launch artifact smoke against the Vercel hostname while still requiring canonical `www` metadata:

```sh
SMOKE_PRODUCTION_URL=https://maintainflow-v2.vercel.app \
SMOKE_ALLOW_NONCANONICAL_TARGET=1 \
pnpm smoke:production
```

Run the cross-tenant denial checks there as well. Only then point `www.maintainflow.io`, verify HTTPS and the intended apex/www redirect, and repeat signup, first Lead form proof, report sharing and billing smoke tests on the canonical domain.

## Launch evidence required

- Exact deployed commit and Vercel deployment.
- Passing local, database, build, canary and production smoke outputs.
- Provider configuration screenshots or IDs without secret values.
- Successful controlled Lead form and Trial signup run IDs.
- Passing cleanup and verified-recovery run IDs.
- Revoked share-link denial and cross-tenant denial.
- Stripe test checkout, webhook reconciliation and portal return.
- Seven consecutive days of scheduled canary health before calling scheduling stable.

No local fixture, green unit test or configured environment variable is by itself evidence that a provider or the production domain works.
