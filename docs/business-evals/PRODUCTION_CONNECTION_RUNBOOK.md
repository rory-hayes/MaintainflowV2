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
4. Configure the canonical site URL and exact confirmation, recovery and Google OAuth redirects for `https://www.maintainflow.io`.
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

Deploy to the production Vercel project without moving public DNS. Against the Vercel deployment URL, prove both controlled templates, inbound email, verification-link allowlisting, required cleanup, a scheduled run, an Incident recovery, a PDF, an expiring/revocable share link, outbound alerts and Stripe test checkout/portal. Keep the scheduler kill switch available throughout.

## 6. Open the global release

After the canary evidence is saved, replace every Stripe test-mode value with its verified live-mode counterpart. Then:

```txt
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

Deploy the exact verified commit. Run the production smoke and cross-tenant denial checks on the Vercel hostname. Only then point `www.maintainflow.io`, verify HTTPS and the intended apex/www redirect, and repeat signup, first Lead form proof, report sharing and billing smoke tests on the canonical domain.

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
