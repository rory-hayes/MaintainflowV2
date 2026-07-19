import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const atomicMigration = readFileSync(
  "supabase/maintainflow_atomic_check_evidence_migration.sql",
  "utf8",
)
const serviceEvidenceContractMigration = readFileSync(
  "supabase/maintainflow_service_evidence_rls_contract_migration.sql",
  "utf8",
)
const assuranceIntegrityMigration = readFileSync(
  "supabase/maintainflow_assurance_integrity_migration.sql",
  "utf8",
)
const freshSchema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const schedulerSql = readFileSync("supabase/maintainflow_scheduler.sql", "utf8")
const migrationRunner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")

function assertOrdered(source: string, earlier: string, later: string) {
  const earlierIndex = source.indexOf(earlier)
  const laterIndex = source.indexOf(later)
  assert.notEqual(earlierIndex, -1, `Missing earlier contract: ${earlier}`)
  assert.notEqual(laterIndex, -1, `Missing later contract: ${later}`)
  assert.ok(earlierIndex < laterIndex, `Expected ${earlier} before ${later}`)
}

function functionDefinition(source: string, functionName: string) {
  const start = source.indexOf(`create or replace function public.${functionName}(`)
  assert.notEqual(start, -1, `Missing ${functionName}`)
  const end = source.indexOf("\n$$;", start)
  assert.notEqual(end, -1, `Missing ${functionName} terminator`)
  return source.slice(start, end + 4)
}

test("atomic check evidence migration is rerunnable, expansion-safe, and data preserving", () => {
  assert.match(atomicMigration, /^begin;/m)
  assert.match(atomicMigration, /^commit;/m)
  assert.match(atomicMigration, /drop function if exists public\.claim_due_checks\(integer, integer, text\)/)
  assert.match(atomicMigration, /create or replace function public\.record_assurance_check_result/)
  assert.match(atomicMigration, /add column if not exists evidence_origin public\.check_run_evidence_origin[\s\S]+default 'legacy_browser'/)
  assert.match(atomicMigration, /drop policy if exists check_runs_members_all/)
  assert.match(atomicMigration, /create policy check_runs_members_insert_legacy[\s\S]+evidence_origin = 'legacy_browser'/)
  assert.match(atomicMigration, /create policy check_runs_members_update_legacy[\s\S]+evidence_origin = 'legacy_browser'/)
  assert.match(atomicMigration, /create policy check_runs_members_delete_legacy[\s\S]+evidence_origin = 'legacy_browser'/)
  assert.doesNotMatch(atomicMigration, /revoke insert, update, delete on public\.check_runs/)
  assert.doesNotMatch(atomicMigration, /^\s*(?:delete\s+from|truncate\s+table|drop\s+table|alter\s+table[^;]+drop\s+column)/im)
})

test("record_assurance_check_result owns one locked and compare-and-swap persistence boundary", () => {
  const rpc = functionDefinition(atomicMigration, "record_assurance_check_result")

  assert.match(rpc, /p_check_id uuid[\s\S]+p_run_id uuid[\s\S]+p_status public\.check_status/)
  assert.match(rpc, /p_expected_check_updated_at timestamptz/)
  assert.match(rpc, /p_expected_workflow_updated_at timestamptz/)
  assert.match(rpc, /p_advance_schedule boolean default true/)
  assert.match(
    rpc,
    /returns table \(\s*run_id uuid,\s*agency_id uuid,\s*workflow_id uuid,\s*status public\.check_status\s*\)/,
  )
  assert.match(rpc, /security definer/)
  assert.match(rpc, /set search_path = public, pg_temp/)

  assertOrdered(rpc, "select w.*", "select c.*")
  assert.match(rpc, /select w\.\*[\s\S]+for update/)
  assert.match(rpc, /select c\.\*[\s\S]+for update/)
  assert.match(rpc, /saved_check\.updated_at is distinct from p_expected_check_updated_at/)
  assert.match(rpc, /saved_workflow\.updated_at is distinct from p_expected_workflow_updated_at/)
  assert.match(rpc, /errcode = '40001'/)

  assert.match(rpc, /Assertion did not meet the configured condition/)
  assert.match(rpc, /insert into public\.check_runs/)
  assert.match(rpc, /evidence_origin,[\s\S]+'service'::public\.check_run_evidence_origin/)
  assert.match(rpc, /existing_run\.evidence_origin is distinct from 'service'/)
  assert.match(rpc, /latest_run\.evidence_origin = 'service'/)
  assert.match(rpc, /source_run\.evidence_origin = 'service'/)
  assert.match(rpc, /'\{\}'::jsonb/)
  assert.match(rpc, /run_id is already bound to different check evidence/)
  assert.match(rpc, /latest_run\.status <> 'skipped'::public\.check_status/)
  assert.match(rpc, /if run_is_latest_non_skipped and p_status = 'healthy'/)
  assert.match(rpc, /status = 'resolved'::public\.issue_status/)
  assert.match(rpc, /status = 'open'::public\.issue_status/)
  assert.match(rpc, /on conflict on constraint issues_agency_dedupe_unique do update/)

  assertOrdered(rpc, "insert into public.check_runs", "update public.issues issue_state")
  assertOrdered(rpc, "on conflict on constraint issues_agency_dedupe_unique do update", "update public.checks check_state")
  assertOrdered(rpc, "update public.checks check_state", "perform public.refresh_workflow_assurance")
})

test("workflow assurance is one canonical multi-check aggregate in migrations and fresh schema", () => {
  const canonicalDefinitions = [atomicMigration, assuranceIntegrityMigration, freshSchema]
    .map((source) => functionDefinition(source, "refresh_workflow_assurance"))
  assert.equal(canonicalDefinitions[1], canonicalDefinitions[0])
  assert.equal(canonicalDefinitions[2], canonicalDefinitions[0])

  const canonical = canonicalDefinitions[0]
  assert.match(canonical, /check_state\.enabled[\s\S]*?not check_state\.pending_setup/)
  assert.match(canonical, /run_state\.evidence_origin = 'service'/)
  assert.match(canonical, /latest_attempt[\s\S]*?latest_conclusive/)
  assert.match(canonical, /latest_status = 'skipped'[\s\S]*?latest_conclusive_status = 'failed' then 4/)
  assert.match(canonical, /latest_status = 'skipped'[\s\S]*?latest_conclusive_status = 'degraded' then 3/)
  assert.match(canonical, /latest_status is null[\s\S]*?latest_status = 'skipped' then 2/)
  assert.match(canonical, /max\(check_truth\.latest_completed_at\)/)

  for (const source of [assuranceIntegrityMigration, freshSchema]) {
    const triggerFunction = functionDefinition(source, "refresh_workflow_assurance_after_check_change")
    assert.match(triggerFunction, /tg_op = 'DELETE'[\s\S]*?old\.agency_id, old\.workflow_id/)
    assert.match(triggerFunction, /old\.agency_id, old\.workflow_id[\s\S]*?new\.agency_id, new\.workflow_id/)
    assert.match(source, /create trigger checks_refresh_workflow_assurance[\s\S]*?after insert or delete or update of enabled, pending_setup, workflow_id, agency_id/)
  }

  for (const source of [atomicMigration, freshSchema]) {
    assert.match(functionDefinition(source, "record_assurance_check_result"), /perform public\.refresh_workflow_assurance\(saved_workflow\.agency_id, saved_workflow\.id\)/)
  }
})

test("expand keeps legacy inserts compatible without allowing service provenance forgery", () => {
  const insertGrant = atomicMigration.match(
    /grant insert \(([\s\S]*?)\) on public\.check_runs to authenticated;/,
  )
  const updateGrant = atomicMigration.match(
    /grant update \(([\s\S]*?)\) on public\.check_runs to authenticated;/,
  )
  assert.ok(insertGrant)
  assert.ok(updateGrant)
  assert.doesNotMatch(insertGrant[1], /evidence_origin/)
  assert.doesNotMatch(updateGrant[1], /evidence_origin/)
  assert.match(atomicMigration, /revoke insert, update on public\.check_runs from authenticated/)
  assert.match(atomicMigration, /grant insert \([\s\S]+created_at[\s\S]+on public\.check_runs to authenticated/)
  assert.match(serviceEvidenceContractMigration, /drop policy if exists check_runs_members_insert_legacy/)
  assert.match(serviceEvidenceContractMigration, /revoke insert \([\s\S]+created_at[\s\S]+on public\.check_runs from authenticated/)
  assert.match(serviceEvidenceContractMigration, /revoke update \([\s\S]+created_at[\s\S]+on public\.check_runs from authenticated/)
})

test("legacy-backed reports and PDF bindings are invalidated without deleting evidence", () => {
  for (const source of [atomicMigration, assuranceIntegrityMigration]) {
    assert.match(source, /legacy_run\.evidence_origin = 'legacy_browser'/)
    assert.match(source, /snapshot_json->'checkRunIds'/)
    assert.match(source, /report_item\.source_type::text = 'check_run'/)
    assert.match(source, /stale_at = coalesce\(report_state\.stale_at, now\(\)\)/)
    assert.match(source, /pdf_snapshot_version = null/)
    assert.doesNotMatch(source, /^\s*(?:delete\s+from|truncate\s+table)/im)
  }
})

test("fresh schema carries the exact atomic RPC and service-only execute boundary", () => {
  assert.equal(
    functionDefinition(freshSchema, "record_assurance_check_result"),
    functionDefinition(atomicMigration, "record_assurance_check_result"),
  )

  for (const source of [atomicMigration, freshSchema]) {
    assert.match(
      source,
      /revoke all on function public\.record_assurance_check_result\([\s\S]+\) from public, anon, authenticated/,
    )
    assert.match(source, /drop policy if exists check_runs_members_insert_legacy/)
    assert.match(
      source,
      /grant execute on function public\.record_assurance_check_result\([\s\S]+\) to service_role/,
    )
  }
})

test("check evidence tables are authenticated select-only", () => {
  for (const source of [serviceEvidenceContractMigration, freshSchema]) {
    assert.match(source, /alter table public\.check_runs enable row level security/)
    assert.match(source, /alter table public\.check_job_runs enable row level security/)
    assert.match(source, /create policy check_runs_members_select[\s\S]+for select to authenticated/)
    assert.match(source, /create policy check_job_runs_members_select[\s\S]+for select to authenticated/)
    assert.match(
      source,
      /revoke insert, update, delete on public\.check_runs, public\.check_job_runs from authenticated/,
    )
    assert.doesNotMatch(source, /create policy check_runs_members_all/)
    assert.doesNotMatch(source, /create policy check_job_runs_members_all/)
  }

  assert.match(serviceEvidenceContractMigration, /^begin;/m)
  assert.match(serviceEvidenceContractMigration, /^commit;/m)
  assert.doesNotMatch(serviceEvidenceContractMigration, /^\s*(?:delete\s+from|truncate\s+table|drop\s+table)/im)
})

test("every claim_due_checks definition returns both CAS timestamps", () => {
  for (const source of [atomicMigration, freshSchema, schedulerSql]) {
    const claim = functionDefinition(source, "claim_due_checks")
    assert.match(claim, /check_updated_at timestamptz/)
    assert.match(claim, /workflow_updated_at timestamptz/)
    assert.match(claim, /c\.updated_at as check_updated_at/)
    assert.match(claim, /w\.updated_at as workflow_updated_at/)
    assert.match(claim, /max_batch integer default 5/)
    assert.match(claim, /greatest\(120, least\(coalesce\(lease_seconds, 180\), 900\)\)/)
    assert.match(claim, /active_claim\.workflow_id = c\.workflow_id[\s\S]+active_claim\.lease_expires_at > now\(\)/)
    assert.match(claim, /candidate\.workflow_id = c\.workflow_id/)
  }
})

test("postbuild applies and verifies privacy before atomic persistence in both phases", () => {
  assert.match(migrationRunner, /maintainflow_atomic_check_evidence_migration\.sql/)
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(checkEvidencePrivacyMigration)",
    "withoutTransactionWrapper(atomicCheckEvidenceMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(atomicCheckEvidenceMigration)",
    "withoutTransactionWrapper(assuranceIntegrityMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(assuranceIntegrityMigration)",
    "withoutTransactionWrapper(serviceEvidenceRlsContractMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(serviceEvidenceRlsContractMigration)",
    "withoutTransactionWrapper(paidPilotRetirementMigration)",
  )
  assert.match(migrationRunner, /maintainflow_service_evidence_rls_contract_migration\.sql/)
  assert.match(migrationRunner, /atomic_check_result_rpc_ready/)
  assert.match(migrationRunner, /workflow_assurance_function_ready/)
  assert.match(migrationRunner, /workflow_assurance_trigger_ready/)
  assert.match(migrationRunner, /workflow_assurance_rows_valid/)
  assert.match(migrationRunner, /claim_due_checks_cas_columns_ready/)
  assert.match(migrationRunner, /authenticated_evidence_tables_select_only/)
  assert.match(migrationRunner, /authenticated_evidence_write_policies_absent/)
  assert.match(migrationRunner, /check_run_provenance_column_ready/)
  assert.match(migrationRunner, /authenticated_cannot_name_service_origin/)
  assert.match(migrationRunner, /expand_check_run_provenance_policies_ready/)
  assert.match(migrationRunner, /authenticated_evidence_column_writes_absent/)
  assert.match(
    migrationRunner,
    /isContractPhase[\s\S]+!state\.authenticated_evidence_tables_select_only[\s\S]+!state\.authenticated_evidence_write_policies_absent/,
  )
  assert.match(migrationRunner, /not has_function_privilege\('authenticated'/)
})
