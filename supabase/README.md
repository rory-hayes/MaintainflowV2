# Maintain Flow Supabase Setup

## 1. Run the schema

Open the Supabase SQL editor for the `MaintainFlow` project and run:

```sql
-- paste the full contents of supabase/maintainflow_schema.sql
```

Then run the internal observability migration:

```sql
-- paste the full contents of supabase/maintainflow_ops_observability.sql
```

Then run the public acquisition measurement migration:

```sql
-- paste the full contents of supabase/maintainflow_public_acquisition_events.sql
```

For existing projects created before the Free plan existed, run the Free-plan migration first. Then run the self-serve entitlement and workspace migrations in this order after the base schema:

```sql
-- only for an existing agency_plan enum that does not yet include `free`:
-- paste the full contents of supabase/maintainflow_free_plan_migration.sql
-- paste the full contents of supabase/maintainflow_billing_entitlements_migration.sql
-- then paste the full contents of supabase/maintainflow_self_serve_workspace_provisioning.sql
-- then paste the full contents of supabase/maintainflow_assurance_expansion_migration.sql
-- then paste the full contents of supabase/maintainflow_check_evidence_privacy_migration.sql
-- then paste the full contents of supabase/maintainflow_atomic_check_evidence_migration.sql
-- then paste the full contents of supabase/maintainflow_scheduler_capacity_migration.sql
-- then paste the full contents of supabase/maintainflow_business_evals_migration.sql
-- then paste the full contents of supabase/maintainflow_legal_acceptances_migration.sql
-- then paste the full contents of supabase/maintainflow_browser_context_leases_migration.sql

-- only after the compatible application artifact is live:
-- paste the full contents of supabase/maintainflow_assurance_integrity_migration.sql
-- then paste the full contents of supabase/maintainflow_service_evidence_rls_contract_migration.sql
-- then paste the full contents of supabase/maintainflow_retire_paid_pilot_runtime.sql
```

Retired paid-pilot migrations remain only in the preserved legacy repository. They are excluded from V2 and must not be applied to a self-serve environment because they revoke the authenticated workspace-creation permission required after signup.

The SQL creates:

- core product tables for agencies, memberships, clients, workflows, checks, check runs, issues, notes, reports, report items, audit events, run-log keys, and synthetic test foundations
- enum types for product statuses
- indexes for foreign keys, RLS predicates, due checks, reports, and run history
- updated-at triggers
- Supabase Auth profile trigger
- authenticated `create_agency_workspace(...)` RPC for one-workspace-per-user self-serve setup, with server-side name validation, slug collision handling, and serialized creation per user
- fail-closed check-run provenance: existing/direct rows are `legacy_browser`; only the service-role-only `record_assurance_check_result(...)` RPC stamps `service` while owning locked, compare-and-swap evidence, issue lifecycle, schedule, lease, and workflow updates in one transaction; current health and report readiness require service coverage for every enabled, non-pending check
- database-enforced issue verification truth plus report-snapshot staleness triggers for evidence and rendered agency/client presentation changes
- Stripe-status-backed paid entitlements, protected billing columns, and database-enforced client, workflow, per-client workflow, and monthly report limits
- RLS policies for authenticated agency members
- private `maintainflow-reports` storage bucket and object policies
- first-party `product_events` analytics for funnel and drop-off reporting
- service-role-only `rate_limit_events` for endpoint-test limiter reporting
- service-role-only `public_acquisition_events` for identifier-free page-view and signup-CTA counts, with 90-day raw-event retention
- additive Business Evals tables and service-only RPCs for owner-authorized Projects, immutable Journey versions, staged eval evidence, schedules, incidents, reports, alerts, and expiring share links; legacy Clients and Workflows remain the physical compatibility records
- exact-version legal acceptance evidence: explicit email signup metadata is captured synchronously by an `auth.users` trigger, Google OAuth acceptance is recorded by a service-only idempotent RPC after authentication, direct email signup without current acceptance is rejected, and new workspace membership is blocked until a current row exists; existing users are not backfilled

The production `postbuild` command detects whether the live enum predates Free and always applies the entitlement, self-serve workspace, assurance expansion, check-evidence privacy, atomic check-evidence, scheduler-capacity expansion, Business Evals, legal-acceptance, and browser-context migrations when `VERCEL_ENV=production` and `DATABASE_URL` is configured. It verifies the Business Evals relations, critical RPC signatures, service-only evidence boundary, legal-acceptance trigger/privilege boundary, and removal of direct authenticated team writes before committing. The privacy migration is backward-compatible: it removes legacy response-derived assertion details and normalized result blobs, then enforces structural pass/fail-only evidence on every check-run write. The atomic expansion adds the service-only persistence RPC, provenance marker, and scheduler compare-and-swap timestamps. It preserves the old artifact's legacy write path, but RLS and column grants prevent browser credentials from stamping/promoting `service` or changing a service row. Legacy rows remain stored but are excluded from customer health, issue verification, activation, reports, and PDFs; any existing snapshot/PDF binding that cites them is marked stale. `MAINTAINFLOW_MIGRATION_PHASE` defaults to `expand`. After the compatible artifact is proven live, set `MAINTAINFLOW_MIGRATION_PHASE=contract` for a second deployment; only contract phase reapplies the legacy-report invalidation, rebuilds derived workflow/check health from service rows, applies and verifies full assurance integrity, changes check-run and job-run access to authenticated select-only, and retires the paid-pilot runtime. Both phases are serialized with a database advisory lock, use bounded timeouts, and run inside one transaction so any failure rolls back before the build exits. Before each phase, set `MIGRATION_DRY_RUN=true` with the intended phase and `DATABASE_URL`; the script executes that phase and verification path, then explicitly rolls back. A code build is not authorization to mutate production data or permissions.

## 2. Configure app environment variables

Do not commit real secrets. Use these names in `.env.local` and deployment env settings:

```txt
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PROJECT_REF=<project-ref>
# Optional after Supabase custom domain activation:
# NEXT_PUBLIC_SUPABASE_AUTH_URL=https://auth.maintainflow.io
NEXT_PUBLIC_SUPABASE_ANON_KEY=<sb_publishable_ browser-safe key>
SUPABASE_SERVICE_ROLE_KEY=<sb_secret_ server-only key>
DATABASE_URL=postgresql://postgres:<database-password>@db.<project-ref>.supabase.co:5432/postgres
MAINTAINFLOW_OPS_ROUTE_KEY=<private route key for /control-room/[key]>
OPS_ADMIN_EMAILS=<comma-separated allowlist>
```

Use the project base URL above for Supabase client libraries. The `/rest/v1/` URL is the PostgREST endpoint, not the usual `NEXT_PUBLIC_SUPABASE_URL` value. If a branded Supabase custom domain is active, set `NEXT_PUBLIC_SUPABASE_AUTH_URL` to that auth base URL so OAuth/password auth uses the branded domain while REST and Storage keep using `NEXT_PUBLIC_SUPABASE_URL`.

## 3. Verify in Supabase

After the SQL succeeds, confirm:

- Table Editor shows the Maintain Flow tables under `public`.
- Authentication has the `on_auth_user_created` trigger on `auth.users`.
- Storage has a private bucket named `maintainflow-reports`.
- RLS is enabled on the public tables.
- The SQL editor can run:

```sql
select to_regclass('public.agencies') as agencies_table;
select to_regclass('public.workflows') as workflows_table;
select to_regclass('public.reports') as reports_table;
select to_regclass('public.public_acquisition_events') as acquisition_events_table;
select to_regclass('public.legal_acceptances') as legal_acceptances_table;
select id, public from storage.buckets where id = 'maintainflow-reports';
```

- Supabase Auth has **Allow new users to sign up** enabled.
- `auth_users_capture_maintainflow_legal_acceptance` exists on `auth.users`, `memberships_require_current_legal_acceptance` exists on `public.memberships`, and neither `anon` nor `authenticated` has access to `public.legal_acceptances`.
- A fresh email/password or Google user with durable current acceptance can call `create_agency_workspace(...)` once and receive an owner membership in a Free workspace. A trusted Supabase team invite may reserve its requested membership before activation, but no acceptance row is created until the recipient explicitly accepts in the password-activation screen.
- A second workspace-creation attempt for the same user is rejected, and authenticated users cannot update billing-entitlement columns directly.

## 4. App connection

The app uses the public Supabase URL and publishable key for Auth, PostgREST, and
private report PDF Storage access:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PROJECT_REF` (must exactly match the project URL)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Report exports are uploaded to the private `maintainflow-reports` bucket and
persist `reports.pdf_storage_path`. Downloads go through
`/api/reports/[id]/download`, which requires the signed-in user's bearer token.
Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. New `sb_secret_` keys are sent in
the Supabase `apikey` header only; the legacy bearer form is retained solely for
backward-compatible local migrations and is rejected by production release checks. Scheduled checks and immutable
report PDF creation and download use it only after authorizing the requesting
user and validating current evidence; never expose it to browser code.
Authenticated browser users have no direct select, insert, update, or delete
policy for report-bucket objects.

## 4.1 Configure Google OAuth

Maintain Flow uses Supabase Auth for Google sign-in. Create a Google OAuth Web client in Google Cloud Console, then add the credentials to Supabase Auth Providers.

Google OAuth client values:

```txt
Application type: Web application
Name: Maintain Flow
Authorized JavaScript origins:
  http://localhost:3000
  https://www.maintainflow.io
Authorized redirect URIs:
  https://<project-ref>.supabase.co/auth/v1/callback
  https://auth.maintainflow.io/auth/v1/callback  # after Supabase custom domain activation
```

Supabase dashboard:

1. Open Authentication -> Providers -> Google.
2. Enable Google.
3. Paste the Google Client ID and Client Secret.
4. Save.

Branded hosted OAuth prompt:

1. Configure a Supabase custom domain for the auth host, for example `auth.maintainflow.io`.
2. Add the DNS record Supabase provides and wait for the custom domain to become active.
3. Add `https://auth.maintainflow.io/auth/v1/callback` to the Google OAuth Web client's authorized redirect URIs.
4. Set `NEXT_PUBLIC_SUPABASE_AUTH_URL=https://auth.maintainflow.io` in Vercel and local env.
5. Keep `NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co`; the app still uses the project URL for PostgREST and Storage.

App callback route:

```txt
http://localhost:3000/auth/callback
https://www.maintainflow.io/auth/callback
https://www.maintainflow.io/auth/confirm
https://www.maintainflow.io/reset-password
```

The app starts Google OAuth through Supabase and installs a session only after exchanging a code with the OAuth-specific browser-held PKCE verifier. Email confirmation and password recovery do not use browser-held PKCE state: their custom hosted templates deliver one-time `TokenHash` values in fragments on exact allowlisted redirects, which the app captures, scrubs, and verifies through a same-origin server action. No temporary confirmation/recovery session is returned to or stored by the browser, and each is globally revoked. Confirmation requires exact durable signup acceptance and then normal sign-in; recovery requires explicit exact-current acceptance before the password changes. Generic access/refresh-token fragments remain rejected. The typed invitation flow retains its existing captured-and-scrubbed credentials, explicit password/legal action, global revocation, and normal sign-in requirement. Email click tracking must remain disabled for both token-hash templates.

## 5. Configure branded auth emails

Email/password signup is customer-facing. Do not launch it with the default Supabase template copy or sender.

Apply the checklist and copy/paste templates in:

```txt
supabase/auth-email-templates.md
```

At minimum, verify the hosted Supabase settings use:

```txt
Site URL: https://www.maintainflow.io
Redirect URLs:
  https://www.maintainflow.io/auth/callback
  https://www.maintainflow.io/auth/confirm
  https://www.maintainflow.io/reset-password
  https://maintainflow-v2.vercel.app/auth/callback
  https://maintainflow-v2.vercel.app/auth/confirm
  https://maintainflow-v2.vercel.app/reset-password
```

Approved token-hash fragments exist only on `/auth/confirm` and `/reset-password`. Never add a root hash callback, wildcard redirect, or access/refresh-token callback. The root handler ignores access/refresh fragments, and `/auth/callback` rejects them before network or storage access.

## 6. Retire pilot lead capture

New customers enter through `/sign-up`; they do not submit an application or wait for founder approval. Do not configure `PILOT_LEAD_NOTIFICATION_EMAIL`, present `/contact-sales` as an acquisition path, or apply the contact-sales migrations for a new self-serve deployment. The fresh schema does not create the retired lead-capture table, notification functions, retry job, or accepted-pilot provisioning RPC.

For an existing production database, `maintainflow_retire_paid_pilot_runtime.sql` preserves the `contact_sales_leads` table and rows as historical business records while unscheduling the retry job and dropping the obsolete notification and accepted-pilot functions. Delete historical rows or the table only under the applicable retention policy and a separate, explicit production change.

## 7. Configure scheduled checks, evals, and alert delivery

Run the scheduler migration in the Supabase SQL editor:

```sql
-- paste the full contents of supabase/maintainflow_scheduler.sql
```

This adds:

- lease columns on `public.checks`
- `public.claim_due_checks(...)` for atomic due-check claiming with `for update skip locked`, including the check and workflow timestamps required by evidence compare-and-swap
- optional `pg_cron` + `pg_net` setup for calling the legacy-check, business-eval, Browser Context cleanup, and alert-delivery cron routes

Set these app environment variables locally and in production:

```txt
CRON_SECRET=<long random secret>
CHECK_RUNNER_BATCH_SIZE=5
CHECK_RUNNER_LEASE_SECONDS=180
# Defaults to 4 and is clamped to 1-4 contexts per cron pass.
BROWSER_CONTEXT_CLEANUP_BATCH_SIZE=4
ALERT_DELIVERY_BATCH_SIZE=10
ALERT_ENDPOINT_ENCRYPTION_KEY=<at-least-32-random-characters>
RESEND_API_KEY=<Resend API key>
MAINTAINFLOW_ALERT_FROM_EMAIL=<verified Resend sender>
```

Then configure the Supabase schedule with the same `CRON_SECRET` and the deployed app URL:

```sql
select public.configure_maintainflow_scheduler(
  'https://www.maintainflow.io',
  'replace-with-the-same-secret-as-CRON_SECRET',
  '* * * * *'
);
```

The preferred helper stores the app URL and cron secret in Supabase Vault before scheduling the job. If Vault setup fails in your project, use the direct fallback:

```sql
select public.configure_maintainflow_scheduler_direct(
  'https://www.maintainflow.io',
  'replace-with-the-same-secret-as-CRON_SECRET',
  '* * * * *'
);
```

The fallback stores the generated HTTP command in `cron.job`, so use it only if the Vault-backed helper is not available.

Confirm the scheduled job exists:

```sql
select jobid, jobname, schedule, command
from cron.job
where jobname in (
  'maintainflow-run-checks',
  'maintainflow-run-checks-2',
  'maintainflow-run-evals',
  'maintainflow-cleanup-browser-contexts',
  'maintainflow-deliver-eval-alerts'
);
```

You can also run the read-only verification helper:

```sql
-- paste the full contents of supabase/maintainflow_scheduler_verify.sql
```

The final schedule uses two legacy-check dispatchers, one business-eval dispatcher, one dedicated Browser Context cleanup worker, and one alert-delivery worker every minute. The cleanup worker requests at most four contexts and uses a 60-second transport timeout; the application gives each Browserbase call five seconds with no SDK retry, then records an idempotent database retry for a later pass. Alert delivery claims at most ten due rows, retries transient failures with exponential backoff, and permanently stops after eight attempts. `ALERT_ENDPOINT_ENCRYPTION_KEY` encrypts destinations and signing secrets at rest; keep it stable and secret. Webhook signing secrets are shown only when created or rotated.

Each legacy-check invocation claims at most five checks and runs that one wave concurrently, so launch capacity is 10 check starts per minute or 600 per hour. That is twice the 300-workflow Scale plan's minimum hourly cadence. Claims select at most one due check per workflow per worker, avoiding workflow compare-and-swap collisions. New workflows only need a default `checks.next_run_at`; the global workers pick them up automatically.

Existing installations are upgraded in two phases. `maintainflow_scheduler_capacity_migration.sql` preserves the installed Vault-backed or direct command, sets the `pg_net` timeout to 60 seconds, installs both minute workers, and explicitly sends one check per request so the previously live sequential artifact remains safe during expansion. `maintainflow_browser_context_cleanup_scheduler_migration.sql` derives a separate bounded cleanup job from the installed eval command without changing the legacy eval job. After the concurrent artifact is proven live, contract phase applies `maintainflow_scheduler_capacity_contract_migration.sql` and raises both check requests to five. The production migration runner verifies one-check commands in expansion, five-check commands in contract, and the four-context cleanup command in both phases.

## 8. Smoke test the cron route

After the app is running with `CRON_SECRET` configured, run:

```bash
pnpm smoke:cron
```

The script verifies:

- unauthenticated requests to `/api/cron/run-checks` return `401`
- authenticated requests return a scheduler summary without printing secrets
