import assert from "node:assert/strict"
import { Client } from "pg"

const connectionString = String(process.env.DATABASE_URL || "").trim()
assert.ok(connectionString, "DATABASE_URL is required.")

const database = new Client({
  connectionString,
  ssl: connectionString.includes("supabase.co") || connectionString.includes("pooler.supabase.com")
    ? { rejectUnauthorized: false }
    : undefined,
})

try {
  await database.connect()
  const functionResult = await database.query(`
      select p.proname, p.prosecdef, pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'enforce_eval_incident_note_client_mutation_boundary',
          'enforce_issue_source_client_mutation_boundary',
          'record_business_eval_incident_repair'
        )
    `)
  const triggerResult = await database.query(`
      select tgname, pg_get_triggerdef(oid) as definition
      from pg_trigger
      where tgrelid = 'public.issues'::regclass
        and not tgisinternal
    `)
  const grantResult = await database.query(`
      select routine_name, grantee, privilege_type
      from information_schema.routine_privileges
      where specific_schema = 'public'
        and routine_name = 'record_business_eval_incident_repair'
      order by grantee
    `)

  const functions = Object.fromEntries(
    functionResult.rows.map((row) => [row.proname, row])
  )
  const triggers = Object.fromEntries(
    triggerResult.rows.map((row) => [row.tgname, row.definition])
  )
  const repairGrants = grantResult.rows

  const proof = {
    noteGuardSecurityInvoker:
      functions.enforce_eval_incident_note_client_mutation_boundary?.prosecdef === false,
    noteGuardUsesCurrentUser: /current_user/.test(
      functions.enforce_eval_incident_note_client_mutation_boundary?.definition || ""
    ),
    noteGuardDoesNotUseSessionUser: !/session_user/.test(
      functions.enforce_eval_incident_note_client_mutation_boundary?.definition || ""
    ),
    sourceGuardSecurityInvoker:
      functions.enforce_issue_source_client_mutation_boundary?.prosecdef === false,
    sourceGuardChecksCheckRun: /check_run_id/.test(
      functions.enforce_issue_source_client_mutation_boundary?.definition || ""
    ),
    sourceMutationTriggerActive: /check_run_id/.test(
      triggers.issues_source_client_mutation_boundary || ""
    ),
    verificationTriggerRechecksCheckRun: /check_run_id/.test(
      triggers.issues_enforce_verification_truth || ""
    ),
    repairUsesRowLock: /FOR UPDATE/i.test(
      functions.record_business_eval_incident_repair?.definition || ""
    ),
    repairUsesOptimisticVersion: /expected_updated_at/.test(
      functions.record_business_eval_incident_repair?.definition || ""
    ),
    repairRpcIsServiceOnly:
      repairGrants.some((grant) => grant.grantee === "service_role" && grant.privilege_type === "EXECUTE")
      && repairGrants.every((grant) => ["postgres", "service_role"].includes(grant.grantee)),
  }

  const failed = Object.entries(proof).filter(([, passed]) => !passed).map(([name]) => name)
  if (failed.length > 0) {
    process.stderr.write(`${JSON.stringify({
      failed,
      functionSecurityDefiner: Object.fromEntries(
        Object.entries(functions).map(([name, value]) => [name, value.prosecdef])
      ),
      issueTriggers: Object.keys(triggers).sort(),
      issueTriggerDefinitions: triggers,
      repairGrants,
    }, null, 2)}\n`)
  }
  assert.deepEqual(failed, [], `Production security-remediation proofs failed: ${failed.join(", ")}`)
  process.stdout.write(`${JSON.stringify({ result: "passed", proof }, null, 2)}\n`)
} finally {
  await database.end().catch(() => undefined)
}
