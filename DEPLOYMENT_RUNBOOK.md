# Maintain Flow Business Evals deployment runbook

This is the repository release path. The provider order and acceptance evidence are defined in [`docs/business-evals/PRODUCTION_CONNECTION_RUNBOOK.md`](docs/business-evals/PRODUCTION_CONNECTION_RUNBOOK.md); `SOURCE_OF_TRUTH.md` wins if any older document conflicts.

## Canonical production target

- Remote: `https://github.com/rory-hayes/MaintainflowV2.git`
- Vercel project: `maintainflow-v2` at `https://vercel.com/rorys-projects-accf0d71/maintainflow-v2`
- Production branch: `main`
- Canonical domain: `https://www.maintainflow.io`
- Supabase data and provider rollout: new-project full schema or the documented expand/contract path for the existing project

Do not describe a local build, green test run, configured environment variable, Vercel build, or provider dashboard screenshot as a live production proof.

This is the superseding V2 release destination. Preserve the former `rory-hayes/maintainflow` repository and `maintainflow` Vercel project as legacy history; do not delete, rewrite, force-push, or deploy the V2 release through them.

## 1. Prove the exact local release candidate

Run every gate after the last source or environment change:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm audit
pnpm test:business-evals:database
pnpm test:business-evals:e2e
pnpm build
```

Then inspect the worktree and exact diff. Do not stage unrelated files from a mixed worktree.

```bash
git status -sb
git diff --check
git remote get-url origin
```

The remote output must be exactly `https://github.com/rory-hayes/MaintainflowV2.git`. `pnpm deploy:check` also blocks if the Git remote or local Vercel project link points elsewhere.

## 2. Publish through review

For the one-time bootstrap of an empty V2 repository, publish only a fresh-history, allowlisted snapshot after all gates, staged-diff review, and both Gitleaks and TruffleHog scans pass. That first commit establishes `main`; it must not import or rewrite the legacy repository history.

After bootstrap, start from current `origin/main`, use one reviewed short-lived branch, and follow the exact merged commit through release. Never push a later unreviewed local branch directly to `main`.

```bash
git add <reviewed-files-only>
git commit -m "Prepare Business Evals production release"
git push -u origin <short-lived-branch>
```

Open and review one pull request. Record the merged commit before creating a Vercel release candidate.

## 3. Connect providers in the required order

Follow the [production connection runbook](docs/business-evals/PRODUCTION_CONNECTION_RUNBOOK.md) exactly:

1. Supabase schema, private buckets, RLS, Auth, Google OAuth and hosted email attestations.
2. Browserbase through the dedicated policy-enforcing external proxy.
3. Resend outbound and the signed inbound subdomain.
4. Stripe test-mode canary Prices/webhook/portal, followed by separate live-mode launch values.
5. Vercel selected-workspace canary, global release, then public DNS.

The reviewed `.env.local` may be used as the source for the **Production** Vercel environment only. Preview and Development need separate test projects and credentials. The helper refuses bulk environment publishing.

Install the current official Vercel CLI as a separate operator tool before running this section. It is deliberately not an application dependency, so CLI-only transitive packages cannot enter the shipped dependency tree. Verify `vercel --version` and authenticate the intended account before continuing.

```bash
pnpm vercel:env:check:canary
vercel login
vercel link --yes --project maintainflow-v2 --scope rorys-projects-accf0d71
pnpm vercel:env:push:canary
```

If the CLI cannot be used, follow [`VERCEL_DASHBOARD_ENV.md`](VERCEL_DASHBOARD_ENV.md). Never paste secret values into chat, docs, commits, screenshots, or release evidence.

## 4. Supabase migration boundary

For a new project, apply `supabase/maintainflow_schema.sql`, then configure the scheduler with the same `CRON_SECRET` used by Vercel. For an existing project, follow [`docs/business-evals/LEGACY_MIGRATION.md`](docs/business-evals/LEGACY_MIGRATION.md) and rehearse each phase before applying it.

The first compatible artifact uses `MAINTAINFLOW_MIGRATION_PHASE=expand`. Do not move to `contract` until that exact artifact is live, its compatibility smoke passes, the rollback rehearsal is saved, and the migration guide authorizes the transition. No legacy table is dropped as part of the Business Evals launch.

Verify the installed database and scheduler rather than assuming the SQL ran:

```bash
pnpm test:business-evals:database
pnpm smoke:cron
```

Run the full contents of `supabase/maintainflow_scheduler_verify.sql` against the intended production project and save the non-secret results.

## 5. Hosted auth truth

The canonical application origin and callback are:

```txt
https://www.maintainflow.io
https://www.maintainflow.io/auth/callback
```

Google's provider callback is the active Supabase Auth callback (project domain or verified custom Auth domain), not the Maintain Flow application callback. Google client credentials remain in the Supabase provider dashboard and are not copied to Vercel. Set `SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED=true` only after an isolated hosted Google sign-in returns to the canonical application successfully.

Do not set `NEXT_PUBLIC_SUPABASE_AUTH_URL` to `auth.maintainflow.io` until the Supabase custom domain and DNS are active. `NEXT_PUBLIC_SUPABASE_URL` always remains the Supabase project base URL for database and Storage calls.

## 6. Selected-workspace canary

The canary uses the production Vercel project without public DNS, a non-empty workspace allowlist, controlled fixture routes, and Stripe test mode. Both kill switches must remain immediately available.

```bash
pnpm deploy:check:canary
pnpm vercel:env:check:canary
pnpm vercel:env:push:canary
```

Deploy the exact reviewed commit. Save evidence for both templates, inbound email, cleanup, scheduling, Incident recovery, PDF/live-link reporting, alerts, cross-tenant denial, and Stripe test checkout/webhook/portal. A green build alone is not canary acceptance.

## 7. Global release and domain

After canary evidence is complete, replace all Stripe test values with the independently verified live-mode key, six distinct Price IDs, webhook secret, and Customer Portal configuration. Clear the workspace allowlist, disable fixture routes, enable the global UI, and rerun the global gates:

```bash
pnpm deploy:check
pnpm vercel:env:check
pnpm vercel:env:push
```

Deploy the exact verified commit and run production smoke tests on the Vercel hostname. Only then point `www.maintainflow.io`, verify HTTPS and apex/www behavior, and repeat signup, first Lead proof, report sharing, cross-tenant denial, live billing, and rollback controls on the canonical domain.

## Release proof

Record:

- exact merged commit and Vercel deployment;
- current local, database, build, canary, and production smoke outputs;
- non-secret provider IDs/configuration evidence;
- controlled Lead form and Trial signup run IDs;
- passing cleanup and verified Incident recovery run IDs;
- revoked share-link and cross-tenant denial evidence;
- Stripe test and bounded live checkout/webhook/portal evidence;
- DNS, HTTPS, canonical redirect, and post-domain smoke evidence;
- seven consecutive days of scheduled production canary health before calling scheduling stable.

If any required provider, migration, billing, tenancy, cleanup, evidence, or rollback check is missing, the release remains blocked.
