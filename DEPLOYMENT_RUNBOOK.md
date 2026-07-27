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

The browser-egress gateway is a separate security boundary and is part of the
same release candidate. Use Go `1.26.5`, Python `3.13.11`, and uv `0.11.29`,
matching the checked-in module and lock contracts. From the repository root:

```bash
cd infra/browser-egress-proxy

unformatted="$(gofmt -l .)"
test -z "${unformatted}"
go mod download
go mod verify
go test -race ./...
go vet ./...
go run ./cmd/generate-iana -root . -check

cd interceptor
uv sync --frozen --python 3.13.11
uv pip install \
  --python .venv/bin/python \
  --require-hashes \
  --requirement build-requirements.lock
uv pip install \
  --python .venv/bin/python \
  --no-deps \
  --require-hashes \
  --requirement source-test-requirements.lock
MF_GATEWAY_WHEEL_DIR="$(mktemp -d)"
MF_GATEWAY_REBUILD_DIR="$(mktemp -d)"
.venv/bin/python build_patched_wheels.py --test --output "${MF_GATEWAY_WHEEL_DIR}"
.venv/bin/python build_patched_wheels.py --output "${MF_GATEWAY_REBUILD_DIR}"
diff --recursive --brief \
  "${MF_GATEWAY_WHEEL_DIR}" \
  "${MF_GATEWAY_REBUILD_DIR}"
uv pip install \
  --python .venv/bin/python \
  --no-deps \
  --reinstall \
  "${MF_GATEWAY_WHEEL_DIR}"/h11-0.16.0-*.whl \
  "${MF_GATEWAY_WHEEL_DIR}"/mitmproxy-12.2.3-*.whl
.venv/bin/python post_image_verify.py --manifest pinned-source.json
.venv/bin/python -m pytest -q tests/test_maintainflow_policy.py

cd ..
interceptor/.venv/bin/python deploy/verify_scaffold.py
interceptor/.venv/bin/python -m unittest discover -s deploy/tests -v

cd ../..
```

The two blocking `Browser egress` CI jobs then rebuild both digest-pinned
deployment images, generate 30-day SPDX JSON SBOM artifacts with Syft
`v1.48.0`, and scan operating-system and library packages with Trivy
`v0.70.0`. Any fixed or unfixed `HIGH` or `CRITICAL` vulnerability blocks the
release; do not waive the result merely because it originates in a base image.
The workflow pins third-party setup, SBOM, and scanner actions to reviewed
commits and does not require registry credentials or application secrets.

When Docker, Syft and Trivy are available to the release operator, reproduce
the image gates locally before publishing an immutable registry digest:

```bash
set -o pipefail
git archive --format=tar HEAD | docker build \
  --file infra/browser-egress-proxy/deploy/images/Dockerfile.dialer \
  --tag maintainflow/browser-egress-dialer:release-candidate \
  -
git archive --format=tar HEAD | docker build \
  --file infra/browser-egress-proxy/deploy/images/Dockerfile.interceptor \
  --tag maintainflow/browser-egress-interceptor:release-candidate \
  -

syft maintainflow/browser-egress-dialer:release-candidate \
  --output spdx-json=browser-egress-dialer.spdx.json
syft maintainflow/browser-egress-interceptor:release-candidate \
  --output spdx-json=browser-egress-interceptor.spdx.json

trivy image --exit-code 1 --severity HIGH,CRITICAL \
  --scanners vuln maintainflow/browser-egress-dialer:release-candidate
trivy image --exit-code 1 --severity HIGH,CRITICAL \
  --scanners vuln maintainflow/browser-egress-interceptor:release-candidate
```

The local commands are evidence only when the operator first records exact
`go version`, `python --version`, `uv --version`, `docker version`, `syft
version`, and `trivy version` output. The tar contexts come from the exact
committed `HEAD`; they intentionally exclude untracked local files and secrets.
CI success is not Fly or Browserbase runtime proof; all live gateway gates in
[`infra/browser-egress-proxy/deploy/README.md`](infra/browser-egress-proxy/deploy/README.md)
remain mandatory before enabling the runner or scheduler.

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

For a new project, apply `supabase/maintainflow_schema.sql`, then configure the scheduler with the same `CRON_SECRET` used by Vercel. Both the Vault-backed and direct-fallback helpers install the dedicated `maintainflow-cleanup-browser-contexts` minute job with `batchSize=4` and a 60-second transport timeout. For an existing project, follow [`docs/business-evals/LEGACY_MIGRATION.md`](docs/business-evals/LEGACY_MIGRATION.md) and rehearse each phase before applying it; the additive cleanup-scheduler migration derives credentials from the installed eval command and must leave `maintainflow-run-evals` unchanged.

The first compatible artifact uses `MAINTAINFLOW_MIGRATION_PHASE=expand`. Do not move to `contract` until that exact artifact is live, its compatibility smoke passes, the rollback rehearsal is saved, and the migration guide authorizes the transition. No legacy table is dropped as part of the Business Evals launch.

Verify the installed database and scheduler rather than assuming the SQL ran:

```bash
pnpm test:business-evals:database
pnpm smoke:cron
```

Run the full contents of `supabase/maintainflow_scheduler_verify.sql` against the intended production project and save the non-secret results. Require `browser_context_cleanup_scheduler_ready=true`, exactly one active cleanup job, a four-context batch, and the still-active legacy eval job. `pnpm smoke:cron` intentionally invokes the bounded cleanup pass when `CRON_SECRET` is present; confirm it reports only aggregate `claimed`, `deleted`, `retryScheduled`, and `persistenceFailed` counts.

## 5. Hosted auth truth

The canonical application origin and Auth routes are:

```txt
https://www.maintainflow.io
https://www.maintainflow.io/auth/callback
https://www.maintainflow.io/auth/confirm
https://www.maintainflow.io/reset-password
```

Google's provider callback is the active Supabase Auth callback (project domain or verified custom Auth domain), not the Maintain Flow application callback. Google client credentials remain in the Supabase provider dashboard and are not copied to Vercel. Google OAuth remains browser-bound PKCE on `/auth/callback`; its OAuth-specific verifier and pending legal state are unchanged. Email confirmation and password recovery instead use one-time Supabase token-hash links that may be opened in another browser or device. The hosted template appends `token_hash` and the exact action type to the fragment of the allowlisted `/auth/confirm` or `/reset-password` redirect. Maintain Flow captures and removes that fragment before display, submits it only to the same-origin server action, never returns or persists the temporary session, and globally revokes it. Confirmation requires a deliberate click and an exact current legal-acceptance row before normal password sign-in; recovery requires an explicit new password and exact current legal acceptance before the password changes. Generic access/refresh-token fragments remain rejected; the existing typed invitation path is the sole exception and retains its capture, scrub, explicit password/legal action, revocation, and sign-in controls. Disable email click tracking for both token-hash templates. Set `SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED=true` only after isolated hosted Google OAuth plus cross-device confirmation and recovery tests pass.

`POST /api/auth/email-action` is intentionally unauthenticated until its one-time token is verified. Its same-origin, Fetch Metadata, strict-schema, body-cap, per-source, and per-runtime checks are application defenses, not a distributed perimeter. Before public launch, add an exact-path Vercel Firewall rate limit for that POST route, retain Supabase's provider rate limits, exclude request bodies from observability, and save a canary 429 response. Do not apply the rule to the confirmation page GET: email scanners may fetch that page, and it deliberately performs no token-consuming action until the user clicks.

Do not set `NEXT_PUBLIC_SUPABASE_AUTH_URL` to `auth.maintainflow.io` until the Supabase custom domain and DNS are active. `NEXT_PUBLIC_SUPABASE_URL` always remains the Supabase project base URL for database and Storage calls, and `NEXT_PUBLIC_SUPABASE_PROJECT_REF` must exactly match its tenant reference. Use a current `sb_publishable_` key in the public variable and a distinct `sb_secret_` key only in the server variable; release checks fail closed on legacy, swapped, or mismatched credentials.

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
- blocking browser-egress source/policy job, both immutable image digests,
  SPDX SBOM artifacts, and zero-`HIGH`/`CRITICAL` Trivy scan evidence;
- non-secret provider IDs/configuration evidence;
- controlled Lead form and Trial signup run IDs;
- passing cleanup and verified Incident recovery run IDs;
- revoked share-link and cross-tenant denial evidence;
- Stripe test and bounded live checkout/webhook/portal evidence;
- DNS, HTTPS, canonical redirect, and post-domain smoke evidence;
- seven consecutive days of scheduled production canary health before calling scheduling stable.

If any required provider, migration, billing, tenancy, cleanup, evidence, or rollback check is missing, the release remains blocked.

Legal completion is equally blocking. Before public checkout or DNS cutover, complete [`docs/business-evals/LEGAL_RELEASE_INPUTS.md`](docs/business-evals/LEGAL_RELEASE_INPUTS.md) with the real operator, address, customer classification, jurisdiction, controller, legal bases, transfers, complaint route, DPA/subprocessor decisions, and jurisdiction-appropriate professional review. Never substitute placeholders or inferred personal details.
