import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const schema = readFileSync("supabase/maintainflow_schema.sql", "utf8")

test("business eval migration preserves legacy physical tables and adds exact product adapters", () => {
  assert.doesNotMatch(migration, /alter table public\.(agencies|clients|workflows)\s+rename/i)
  assert.match(migration, /clients[\s\S]+project_kind text not null default 'client_site'/)
  assert.match(migration, /project_kind in \('own_product', 'client_site', 'personal'\)/)
  assert.match(migration, /workflows[\s\S]+journey_template[\s\S]+draft_definition_json[\s\S]+draft_revision[\s\S]+active_journey_version_id/)
  assert.match(migration, /team_trial_started_at[\s\S]+team_trial_ends_at[\s\S]+team_trial_used_at/)
  assert.match(migration, /enforce_team_trial_one_time/)
  assert.match(migration, /billing_contract_version text not null default 'legacy'/)
  assert.match(migration, /billing_contract_version in \('legacy', 'business_evals_v1'\)/)
})

test("owner attestation is agency and project scoped without fake domain verification", () => {
  assert.match(migration, /create table if not exists public\.project_authorizations/)
  assert.match(migration, /attestation_version text not null/)
  assert.match(migration, /attested_by_user_id uuid not null/)
  assert.match(migration, /approved_action_domains jsonb not null/)
  assert.match(migration, /project_authorizations_attestor_membership_fkey/)
  assert.match(migration, /enforce_project_owner_attestation/)
  assert.match(migration, /project_authorizations_active_host_uidx/)
  assert.match(migration, /Project authorizations are append-only and may only be revoked once/)
  assert.match(migration, /create or replace function public\.record_project_authorization/)
  assert.match(migration, /pause_reason = 'project_authorization_changed'/)
  assert.match(migration, /create or replace function public\.revoke_project_authorizations_and_pause/)
  assert.match(migration, /pause_reason = 'project_authorization_revoked'/)
  assert.match(migration, /hostname_is_covered_by_project_authorization/)
  assert.match(migration, /lower\(target_hostname\) like '%\.' \|\| lower\(approved\.hostname\)/)
  assert.doesNotMatch(migration, /verification_token_hash|dns_txt|html_meta/)
})

test("immutable version, stage, schedule, run, and private evidence contracts are complete", () => {
  for (const table of [
    "journey_versions", "journey_stage_definitions", "journey_schedules", "eval_runs", "eval_stage_runs",
    "eval_run_side_effect_attempts", "eval_rate_limit_buckets", "evidence_artifacts", "inbound_email_events", "eval_email_receiving_health_events", "provider_webhook_receipts", "alert_endpoints", "alert_deliveries", "eval_alert_outbox", "report_share_links",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`))
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  assert.match(migration, /journey_versions_immutable/)
  assert.match(migration, /journey_stage_definitions_immutable/)
  assert.match(migration, /enabled boolean not null default false/)
  assert.match(migration, /interval_minutes integer not null default 1440/)
  assert.match(migration, /maintainflow-eval-evidence[\s\S]+public = false/)
  assert.match(migration, /revoke insert, update, delete on public\.project_authorizations, public\.journey_versions/)
  assert.doesNotMatch(migration, /create policy (?:journey_schedules|journey_versions|eval_runs).*?(?:write|insert)/)
  assert.match(migration, /artifact_kind not in \('screenshot', 'report_json', 'email_event'\) or redacted/)
  assert.match(migration, /display_name text not null default 'Alert destination'/)
  assert.match(migration, /alert_deliveries_event_type_valid/)
  assert.match(migration, /provider_webhook_receipts_provider_event_unique/)
  assert.match(migration, /create or replace function public\.claim_provider_webhook_receipt/)
  assert.match(migration, /create or replace function public\.finish_provider_webhook_receipt/)
  assert.match(migration, /revoke all on table public\.provider_webhook_receipts from public, anon, authenticated/)
  assert.match(migration, /\(eval_run_id is not null\) <> \(issue_id is not null\)/)
})

test("canonical marker migration is rerunnable and keeps each run and its evidence aligned", () => {
  const start = migration.indexOf("-- BEGIN canonical synthetic marker reconciliation")
  const end = migration.indexOf("-- END canonical synthetic marker reconciliation")
  assert.ok(start >= 0 && end > start, "Canonical marker reconciliation block is missing")
  const reconciliation = migration.slice(start, end)

  assert.match(reconciliation, /alter table public\.evidence_artifacts[\s\S]+drop constraint if exists evidence_artifacts_marker_valid/)
  assert.match(reconciliation, /alter table public\.eval_runs[\s\S]+drop constraint if exists eval_runs_synthetic_marker_present/)
  assert.match(reconciliation, /where synthetic_marker !~ '\^MF-EVAL-\[A-F0-9\]\{20\}\$'/)
  assert.match(reconciliation, /regexp_replace\(lower\(synthetic_marker\), '\^mf-eval-', ''\)/)
  assert.match(reconciliation, /else left\(replace\(run\.id::text, '-', ''\), 20\)/)
  assert.match(reconciliation, /update public\.evidence_artifacts artifact[\s\S]+set synthetic_marker = run\.synthetic_marker[\s\S]+run\.id = artifact\.eval_run_id/)
  assert.match(reconciliation, /artifact\.synthetic_marker is distinct from run\.synthetic_marker/)
  assert.match(reconciliation, /add constraint eval_runs_synthetic_marker_present[\s\S]+add constraint evidence_artifacts_marker_valid/)

  const firstDrop = reconciliation.indexOf("drop constraint if exists")
  const runBackfill = reconciliation.indexOf("update public.eval_runs run")
  const evidenceBackfill = reconciliation.indexOf("update public.evidence_artifacts artifact")
  const firstAdd = reconciliation.indexOf("add constraint")
  assert.ok(firstDrop < runBackfill && runBackfill < evidenceBackfill && evidenceBackfill < firstAdd)
})

test("atomic RPCs enforce publish CAS, supervised scheduling, quotas, claiming, and finalization", () => {
  assert.match(migration, /create or replace function public\.create_business_eval_project/)
  assert.match(migration, /from public\.clients where agency_id = p_agency_id and archived_at is null/)
  assert.match(migration, /raise exception 'PROJECT_LIMIT_REACHED'/)
  assert.match(migration, /create or replace function public\.restore_business_eval_project/)
  assert.match(migration, /p_journey_limit integer/)
  assert.match(migration, /create or replace function public\.create_business_eval_journey/)
  assert.match(migration, /from public\.workflows journey[\s\S]+join public\.clients project[\s\S]+project\.archived_at is null/)
  assert.match(migration, /raise exception 'JOURNEY_LIMIT_REACHED'/)
  assert.match(migration, /create or replace function public\.publish_journey_version/)
  assert.match(migration, /draft_revision <> p_expected_draft_revision/)
  assert.match(migration, /action_type not in \([\s\S]+?'navigate'[\s\S]+?'open_email_link'[\s\S]+?'cleanup'/)
  assert.match(migration, /restricted_journey_locator_is_valid/)
  assert.match(migration, /restricted_journey_template_is_valid/)
  assert.match(migration, /Journey draft does not satisfy the deterministic template contract/)
  assert.match(migration, /Trial-signup journeys require a cleanup stage using in_product or webhook mode/)
  assert.match(migration, /Cleanup webhook targets a domain outside the owner attestation/)
  assert.match(migration, /pause_reason = 'new_version_requires_supervised_run'/)
  assert.match(migration, /create or replace function public\.configure_journey_schedule/)
  assert.match(migration, /trigger_source = 'supervised'/)
  assert.match(migration, /journey_template = 'trial_signup' then 360 else 60/)
  assert.match(migration, /create or replace function public\.enqueue_business_eval_run/)
  assert.match(migration, /eval_runs_agency_idempotency_unique/)
  assert.match(migration, /eval_runs_schedule_slot_uidx/)
  assert.match(migration, /Monthly business-eval run quota reached/)
  assert.match(migration, /Legacy endpoint journeys must run through the deterministic endpoint monitor/)
  assert.match(migration, /raise exception 'Project is archived\.'/)
  assert.match(migration, /from public\.agencies a[\s\S]+for update;[\s\S]+select \* into existing_run/)
  assert.doesNotMatch(migration, /coalesce\(a\.eval_run_monthly_limit_override, p_monthly_limit\)/)
  assert.match(migration, /Idempotency key was reused with a different eval-run request/)
  assert.match(migration, /create or replace function public\.claim_due_journey_schedules/)
  assert.match(migration, /join public\.clients c on c\.id = w\.client_id[\s\S]+and c\.archived_at is null/)
  assert.match(migration, /create or replace function public\.claim_eval_run_for_dispatch/)
  assert.match(migration, /create or replace function public\.claim_eval_runs_for_dispatch/)
  assert.match(migration, /dispatch_state = 'dispatching'/)
  assert.match(migration, /create or replace function public\.attach_eval_workflow_run/)
  assert.match(migration, /dispatch_state = 'dispatched'/)
  assert.match(migration, /create or replace function public\.release_eval_run_dispatch_lease/)
  assert.match(migration, /create or replace function public\.claim_due_business_eval_runs/)
  assert.match(migration, /create or replace function public\.claim_business_eval_run/)
  assert.match(migration, /create or replace function public\.heartbeat_business_eval_run/)
  assert.match(migration, /create or replace function public\.begin_eval_run_side_effect_phase/)
  assert.match(migration, /eval_run_side_effect_attempts_run_phase_unique/)
  assert.match(migration, /create or replace function public\.complete_eval_run_side_effect_phase/)
  assert.match(migration, /create or replace function public\.consume_business_eval_rate_limit/)
  assert.match(migration, /on conflict \(scope_type, scope_key_hash, window_started_at\) do update/)
  assert.match(migration, /create or replace function public\.request_business_eval_cancellation/)
  assert.match(migration, /for update skip locked/)
  assert.match(migration, /create or replace function public\.finalize_business_eval_run/)
  assert.match(migration, /exactly one result for every immutable stage/)
  assert.match(migration, /references evidence outside this eval run/)
  assert.match(migration, /pause_reason = case when captcha_detected then 'captcha_detected' else 'cleanup_failed' end/)
  assert.match(migration, /if captcha_detected or derived_cleanup_status = 'failed' then[\s\S]+update public\.workflows set[\s\S]+where id = saved_run\.workflow_id/)
  assert.match(migration, /paused_at = case when pause_reason = 'cleanup_failed' then null else paused_at end/)
  assert.match(migration, /where id = saved_run\.schedule_id and agency_id = saved_run\.agency_id[\s\S]+and journey_version_id = saved_run\.journey_version_id/)
  assert.match(migration, /Cleanup status does not match the immutable cleanup-stage results/)
  assert.match(migration, /insert into public\.eval_alert_outbox/)
  assert.equal((migration.match(/on conflict on constraint eval_alert_outbox_run_unique do nothing/g) ?? []).length, 2)
  assert.match(migration, /on conflict on constraint issues_agency_dedupe_unique do update/)
  assert.match(migration, /verification_issue_id uuid references public\.issues/)
  assert.match(migration, /verification_eval_run_id = saved_run\.id/)
  assert.match(migration, /eval_stage_run_id = excluded\.eval_stage_run_id/)
  assert.match(migration, /first_problem_stage_key/)
})

test("reports and shares bind to immutable evidence while legacy test tables are frozen", () => {
  assert.match(migration, /eval_coverage_snapshot_json jsonb not null/)
  assert.match(migration, /eval_evidence_fingerprint text not null/)
  assert.match(migration, /report_share_links[\s\S]+idempotency_key[\s\S]+snapshot_version[\s\S]+evidence_fingerprint/)
  assert.match(migration, /create or replace function public\.create_business_eval_report_snapshot/)
  assert.match(migration, /create or replace function public\.consume_report_share_link/)
  assert.match(migration, /set access_count = l\.access_count \+ 1/)
  assert.match(migration, /eval_snapshot_idempotency_key/)
  const reportRpc = migration.match(/create or replace function public\.create_business_eval_report_snapshot\([\s\S]*?\n\$\$;/)?.[0] ?? ""
  assert.match(reportRpc, /insert into public\.reports/)
  assert.doesNotMatch(reportRpc, /update public\.reports set/)
  assert.match(migration, /test_packs_frozen/)
  assert.match(migration, /test_cases_frozen/)
  assert.match(migration, /test_runs_frozen/)
  assert.match(migration, /if pg_trigger_depth\(\) > 1 then[\s\S]+return null/)
  assert.match(migration, /enforce_eval_incident_client_mutation_boundary/)
  assert.match(migration, /Eval incidents must use the tenant-scoped service API/)
  assert.match(migration, /enforce_eval_incident_note_client_mutation_boundary/)
  assert.doesNotMatch(migration, /drop table public\.test_(packs|cases|runs)/i)
})

test("canonical fresh schema includes the additive business-evals foundation", () => {
  assert.match(schema, /\nbegin;\s/)
  assert.equal(schema.trim().endsWith("commit;"), true, "Fresh schema must commit its top-level transaction.")
  for (const contract of [
    "project_kind", "journey_template", "journey_versions", "journey_stage_definitions", "journey_schedules",
    "eval_runs", "eval_run_side_effect_attempts", "eval_rate_limit_buckets", "eval_stage_runs", "evidence_artifacts", "eval_alert_outbox", "report_share_links", "publish_journey_version",
    "finalize_business_eval_run",
  ]) {
    assert.ok(schema.includes(contract), `Fresh schema is missing ${contract}`)
  }

  const migrationBody = migration.slice(migration.indexOf("alter table public.agencies"), migration.lastIndexOf("commit;")).trim()
  const schemaBody = schema.slice(
    schema.indexOf("alter table public.agencies", schema.indexOf("-- Business-evals fresh-schema extension")),
    schema.lastIndexOf("commit;"),
  ).trim()
  assert.equal(schemaBody, migrationBody, "Fresh schema business-evals block must exactly match the migration body.")
})

test("eval run SQL uses physical compatibility names and declares each column once", () => {
  const table = migration.match(/create table if not exists public\.eval_runs \(([\s\S]*?)\n\);/)?.[1]
  assert.ok(table, "eval_runs table is missing")
  assert.doesNotMatch(table, /^\s*(?:project_id|journey_id)\s/m)
  for (const required of [
    "client_id", "workflow_id", "started_at", "cancel_requested_at", "verification_issue_id",
    "dispatch_state", "dispatch_lease_expires_at", "dispatch_worker_id", "dispatch_attempts",
  ]) {
    assert.equal((table.match(new RegExp(`^\\s*${required}\\s`, "gm")) ?? []).length, 1, `${required} must be declared once`)
  }
})
