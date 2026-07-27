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
2. Record its exact project reference in `NEXT_PUBLIC_SUPABASE_PROJECT_REF`, keep `NEXT_PUBLIC_SUPABASE_URL` at `https://<project-ref>.supabase.co`, and use a current `sb_publishable_` key publicly plus a distinct `sb_secret_` key server-side. The release checks reject another tenant, a swapped key, a legacy launch key, or a secret key in the browser slot.
3. Apply `supabase/maintainflow_schema.sql` for a new project. For an existing project, follow the documented expand/contract migration sequence.
4. Create private `maintainflow-reports` and `maintainflow-eval-evidence` buckets and verify that authenticated users cannot read or mutate objects directly.
5. Keep the Supabase Site URL canonical at `https://www.maintainflow.io`. Allowlist these exact application redirects before attesting redirects:
   - `https://www.maintainflow.io/auth/callback`
   - `https://www.maintainflow.io/auth/confirm`
   - `https://www.maintainflow.io/reset-password`
   - `https://maintainflow-v2.vercel.app/auth/callback`
   - `https://maintainflow-v2.vercel.app/auth/confirm`
   - `https://maintainflow-v2.vercel.app/reset-password`
   The V2 entries are required for confirmation, recovery and Google OAuth during the isolated canary; do not replace the canonical Site URL with the canary origin and do not use a wildcard.
6. Configure the verified Maintain Flow SMTP sender and approved confirmation/reset/invitation templates. Google OAuth remains browser-bound PKCE. Confirmation and recovery use the exact one-time token-hash fragment links in `supabase/auth-email-templates.md`, work cross-device, capture and scrub before display, verify only through the same-origin server action, return no provider session or token to the browser, and globally revoke the temporary session. Confirmation waits for a deliberate click and requires exact durable signup acceptance; recovery requires an explicit password plus exact current legal acceptance before mutation. Disable email click tracking. Generic access/refresh-token fragments remain rejected. A Supabase invitation may reach `/reset-password` only as a typed invite action and retains its capture, scrub, explicit password/legal action, global revocation, and normal sign-in controls.
7. Record the Supabase Auth readiness variables, including `SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED=true`, only after isolated cross-device confirmation and recovery, typed invitation activation, and browser-bound Google OAuth tests pass. Google client credentials stay in Supabase and are not copied to Vercel.

## 3. Connect the execution and email providers

1. Create one reviewed Browserbase production project and connect its dedicated policy-enforcing public HTTPS egress proxy on port 443. Store its exact project ID and configure `BROWSERBASE_EGRESS_PROXY_SERVER`. Generate a PKCS#8 Ed25519 proxy-signing key, install only its public verification key in the gateway, and configure `BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID`, `BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64`, and `BROWSERBASE_EGRESS_PROXY_AUDIENCE` in the production app. Static proxy passwords, direct egress, managed residential and CAPTCHA-solving fallbacks stay disabled.
2. Upload only the gateway's reviewed public CA certificate to that same Browserbase project. Record the returned opaque ID as `BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID`; never put PEM content or the CA private key in Maintain Flow, Browserbase session input, Vercel, workflow state, logs, or evidence. Eval and scan session creation must supply exactly that ID through `proxySettings.caCertificates` while `ignoreCertificateErrors` remains `false`.
3. Before enabling either runner cohort, prove a real Browserbase session rejects a missing, deleted, or wrong-project certificate ID and succeeds with the reviewed ID plus the catch-all external proxy. Prove the Browserbase SDK and gateway accept the full signed-token credential length, then prove invalid signature/key ID/audience/time bounds and out-of-scope side effects fail closed. Save the non-secret Browserbase project/certificate IDs, proxy signing-key ID and public CA fingerprint in the release packet.
4. Configure Resend outbound sending and a dedicated inbound subdomain routed only to `/api/webhooks/resend/inbound`.
5. Generate separate high-entropy secrets for inbound routing, verification-link encryption, report links, rate-limit key hashing and alert endpoints. `RUN_LOG_KEY_PEPPER` must contain at least 32 random characters.
6. Generate a PKCS#8 Ed25519 cleanup-signing key and publish only its derived JWKS public key.
7. Verify the alert sender and controlled inbound canary before treating a missing expected email as conclusive.

## 3A. Connect error monitoring

1. Create one production Sentry project and configure `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and the secret `SENTRY_AUTH_TOKEN` in the Vercel Production environment.
2. Keep default PII and Session Replay disabled. The checked-in event scrubber removes users, request bodies and URLs, extra data, breadcrumb payloads, email addresses, common credentials, and query strings before delivery.
3. Trigger one controlled client render error and one controlled server request error on the exact canary commit. Confirm both arrive, resolve through uploaded source maps, and contain no submitted identity, email, token, request body, URL query, or private evidence.

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
BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID=<active-key-id>
BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64=<base64-pkcs8-ed25519-private-key>
BROWSERBASE_EGRESS_PROXY_AUDIENCE=maintainflow-browser-egress
BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID=<reviewed-browserbase-certificate-id>
BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT=<reviewed-internal-minute-ceiling>
BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT=<reviewed-internal-byte-ceiling>
BROWSERBASE_USAGE_WARNING_PERCENT=80
BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS=12
BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES=60
```

Choose the two Browserbase ceilings only after reviewing the active provider plan and measured canary distribution. They are internal commercial circuit breakers and do not change the locked customer plan prices or run quotas. Leave headroom for bounded sessions already active at the last provider sample. The runtime calls Browserbase Project Usage before every new provider session and fails before `sessions.create` if the sample is unavailable or a ceiling is reached. The scheduler also performs a claimed daily reconciliation.

Browserbase currently returns `browserMinutes` and `proxyBytes` but no billing-period identifier or reset timestamp from the Project Usage endpoint. A decreasing counter is therefore ambiguous and intentionally becomes a blocking metering error. Do not open the runner until Browserbase confirms the production project's counter period/reset semantics or a reviewed monthly re-baseline procedure exists. See `BROWSERBASE_USAGE_COST_CONTROLS.md`.

Then run:

```sh
pnpm deploy:check:canary
pnpm vercel:env:check:canary
pnpm vercel:env:push:canary
```

Deploy to the production Vercel project without moving public DNS. First run `pnpm smoke:canary` and require an unauthenticated application response on the stable `https://maintainflow-v2.vercel.app` production domain, including reachable Resend and Stripe webhook routes and the dedicated Browser Context cleanup cron route rejecting unsigned requests. Do not use a protected unique deployment URL for provider callbacks. Then prove both controlled templates, inbound email, verification-link allowlisting, required cleanup, a scheduled run, an Incident recovery, a PDF, an expiring/revocable share link, outbound alerts and Stripe test checkout/portal. Keep the scheduler kill switch available throughout.

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
- Read-only scheduler verification showing exactly one active `maintainflow-cleanup-browser-contexts` minute job with `batchSize=4`, a 60-second transport timeout, and the existing `maintainflow-run-evals` job still active.
- Authorized `pnpm smoke:cron` output containing only aggregate cleanup counts; no Context, session, run, credential, or provider-error detail.
- Revoked share-link denial and cross-tenant denial.
- Stripe test checkout, webhook reconciliation and portal return.
- Seven consecutive days of scheduled canary health before calling scheduling stable.

No local fixture, green unit test or configured environment variable is by itself evidence that a provider or the production domain works.
