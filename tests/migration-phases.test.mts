import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const expansionMigration = readFileSync(
  "supabase/maintainflow_assurance_expansion_migration.sql",
  "utf8",
)
const migrationRunner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")
const evidencePrivacyMigration = readFileSync(
  "supabase/maintainflow_check_evidence_privacy_migration.sql",
  "utf8",
)
const schedulerCapacityMigration = readFileSync(
  "supabase/maintainflow_scheduler_capacity_migration.sql",
  "utf8",
)
const schedulerCapacityContractMigration = readFileSync(
  "supabase/maintainflow_scheduler_capacity_contract_migration.sql",
  "utf8",
)
const deployReadiness = readFileSync("scripts/local-deploy-readiness.mjs", "utf8")
const envPublisher = readFileSync("scripts/push-vercel-env.mjs", "utf8")
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>
}

function assertOrdered(source: string, earlier: string, later: string) {
  const earlierIndex = source.indexOf(earlier)
  const laterIndex = source.indexOf(later)
  assert.notEqual(earlierIndex, -1, `Missing earlier contract: ${earlier}`)
  assert.notEqual(laterIndex, -1, `Missing later contract: ${later}`)
  assert.ok(earlierIndex < laterIndex, `Expected ${earlier} before ${later}`)
}

test("assurance expansion is idempotent and contains only backward-compatible columns", () => {
  assert.equal((expansionMigration.match(/add column if not exists/g) ?? []).length, 8)
  assert.match(expansionMigration, /alter table public\.issues[\s\S]+repair_recorded_at timestamptz[\s\S]+verification_run_id uuid/)
  assert.match(
    expansionMigration,
    /alter table public\.reports[\s\S]+snapshot_version integer not null default 0[\s\S]+snapshot_json jsonb not null default '\{\}'::jsonb[\s\S]+evidence_fingerprint text not null default ''[\s\S]+stale_at timestamptz[\s\S]+pdf_snapshot_version integer/,
  )
  assert.match(
    expansionMigration,
    /alter table public\.report_items[\s\S]+snapshot_version integer not null default 0/,
  )
  assert.doesNotMatch(
    expansionMigration,
    /create\s+(?:or replace\s+)?function|create\s+(?:unique\s+)?index|create\s+trigger|add\s+constraint|drop\s+(?:function|table|column|constraint|policy|trigger)|update\s+public\.|delete\s+from|insert\s+into/i,
  )
})

test("postbuild defaults to expand and gates assurance and paid-pilot contractions", () => {
  assert.equal(packageJson.scripts?.postbuild, "node scripts/apply-self-serve-workspace-access.mjs")
  assert.match(
    migrationRunner,
    /process\.env\.MAINTAINFLOW_MIGRATION_PHASE \?\? "expand"/,
  )
  assert.match(migrationRunner, /\["expand", "contract"\]/)
  assert.match(migrationRunner, /maintainflow_assurance_expansion_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_check_evidence_privacy_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_atomic_check_evidence_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_scheduler_capacity_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_business_evals_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_scheduler_capacity_contract_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_service_evidence_rls_contract_migration\.sql/)
  assert.match(migrationRunner, /maintainflow_public_monitor_contract_migration\.sql/)
  assert.match(
    migrationRunner,
    /select count\(\*\) = 2[\s\S]+table_name = 'issues'[\s\S]+column_name in \('repair_recorded_at', 'verification_run_id'\)[\s\S]+as issue_verification_columns_ready/,
  )
  assert.match(
    migrationRunner,
    /\$\{isContractPhase \? `not exists \([\s\S]+public\.saved_monitor_endpoint_is_safe[\s\S]+` : "false"\} as public_monitor_rows_safe/,
    "Expand verification must not parse contract-only public-monitor functions.",
  )

  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(entitlementMigration)",
    "withoutTransactionWrapper(workspaceMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(workspaceMigration)",
    "withoutTransactionWrapper(assuranceExpansionMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(assuranceExpansionMigration)",
    "withoutTransactionWrapper(checkEvidencePrivacyMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(checkEvidencePrivacyMigration)",
    "withoutTransactionWrapper(atomicCheckEvidenceMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(atomicCheckEvidenceMigration)",
    "withoutTransactionWrapper(schedulerCapacityMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(schedulerCapacityMigration)",
    "withoutTransactionWrapper(businessEvalsMigration)",
  )
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(businessEvalsMigration)",
    "withoutTransactionWrapper(assuranceIntegrityMigration)",
  )
  assert.match(migrationRunner, /business_evals_foundation_ready/)
  assert.match(migrationRunner, /business_evals_rpcs_ready/)
  assert.match(migrationRunner, /business_evals_service_boundary_ready/)

  const contractBlock = migrationRunner.match(
    /if \(isContractPhase\) \{[\s\S]*?await client\.query\(withoutTransactionWrapper\(schedulerCapacityContractMigration\)\)\s+await client\.query\(withoutTransactionWrapper\(assuranceIntegrityMigration\)\)\s+await client\.query\(withoutTransactionWrapper\(serviceEvidenceRlsContractMigration\)\)\s+await client\.query\(withoutTransactionWrapper\(publicMonitorContractMigration\)\)\s+await client\.query\(withoutTransactionWrapper\(paidPilotRetirementMigration\)\)\s+\}/,
  )
  assert.ok(contractBlock, "Contract migrations must share one explicit phase gate.")
  assert.equal(
    (migrationRunner.match(/withoutTransactionWrapper\(assuranceIntegrityMigration\)/g) ?? []).length,
    1,
  )
  assert.equal(
    (migrationRunner.match(/withoutTransactionWrapper\(serviceEvidenceRlsContractMigration\)/g) ?? []).length,
    1,
  )
  assert.equal(
    (migrationRunner.match(/withoutTransactionWrapper\(publicMonitorContractMigration\)/g) ?? []).length,
    1,
  )
  assert.equal(
    (migrationRunner.match(/withoutTransactionWrapper\(paidPilotRetirementMigration\)/g) ?? []).length,
    1,
  )
})

test("scheduler capacity expansion preserves installed credentials and enforces the launch envelope", () => {
  assert.match(schedulerCapacityMigration, /to_regclass\('cron\.job'\)/)
  assert.match(schedulerCapacityMigration, /select command[\s\S]+jobname = 'maintainflow-run-checks'/)
  assert.match(schedulerCapacityMigration, /timeout_milliseconds := 60000/)
  assert.match(schedulerCapacityMigration, /'''batchSize'', 1'/)
  assert.match(schedulerCapacityMigration, /cron\.schedule\(\s*'maintainflow-run-checks'/)
  assert.match(schedulerCapacityMigration, /cron\.schedule\(\s*'maintainflow-run-checks-2'/)
  assert.equal((schedulerCapacityMigration.match(/'\* \* \* \* \*'/g) ?? []).length, 2)
  assert.doesNotMatch(schedulerCapacityMigration, /delete\s+from|truncate\s+|drop\s+table|alter\s+table/i)
  assert.match(migrationRunner, /scheduler_capacity_ready/)
  assert.match(migrationRunner, /isContractPhase \? 5 : 1/)
  assert.match(migrationRunner, /count\(distinct jobname\) = 2/)
  assert.match(migrationRunner, /timeout_milliseconds\\\\s\*:=\\\\s\*60000/)
})

test("scheduler capacity activates five-check waves only in contract phase", () => {
  assert.match(schedulerCapacityContractMigration, /'''batchSize'', 5'/)
  assert.match(schedulerCapacityContractMigration, /cron\.schedule\(\s*'maintainflow-run-checks'/)
  assert.match(schedulerCapacityContractMigration, /cron\.schedule\(\s*'maintainflow-run-checks-2'/)
  assertOrdered(
    migrationRunner,
    "withoutTransactionWrapper(schedulerCapacityMigration)",
    "withoutTransactionWrapper(schedulerCapacityContractMigration)",
  )
})

test("both rollout phases erase response-derived assertion and result evidence", () => {
  assert.match(evidencePrivacyMigration, /create trigger check_runs_sanitize_evidence/)
  assert.match(evidencePrivacyMigration, /new\.result_json := '\{\}'::jsonb/)
  assert.match(evidencePrivacyMigration, /Assertion did not meet the configured condition/)
  assert.match(evidencePrivacyMigration, /jsonb_object_keys/)
  assert.doesNotMatch(evidencePrivacyMigration, /actual|expected|responseText/)
  assert.match(migrationRunner, /check_evidence_privacy_trigger_ready/)
  assert.match(migrationRunner, /check_evidence_rows_privacy_safe/)
})

test("migration verification distinguishes expansion readiness from contract readiness", () => {
  assert.match(migrationRunner, /report_item_snapshot_column_ready/)
  assert.match(migrationRunner, /assuranceExpansionReady/)
  assert.match(migrationRunner, /workflow_assurance_function_ready/)
  assert.match(migrationRunner, /workflow_assurance_trigger_ready/)
  assert.match(migrationRunner, /workflow_assurance_rows_valid/)
  assert.match(migrationRunner, /isContractPhase\s+&& \([\s\S]+assurance_staleness_triggers_ready/)
  assert.match(
    migrationRunner,
    /to_regprocedure\('public\.mark_assurance_reports_stale\(\)'\)/,
  )
  assert.match(
    migrationRunner,
    /to_regprocedure\('public\.enforce_issue_verification_truth\(\)'\)/,
  )
  assert.doesNotMatch(migrationRunner, /::regprocedure/)
})

test("production environment helpers carry the release-controlled migration phase", () => {
  assert.match(deployReadiness, /"MAINTAINFLOW_MIGRATION_PHASE"/)
  assert.match(envPublisher, /"MAINTAINFLOW_MIGRATION_PHASE"/)
})
