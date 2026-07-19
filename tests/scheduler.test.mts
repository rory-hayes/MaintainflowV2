import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { isAuthorizedCronRequest } from "../src/lib/core/cron-auth.ts"
import { handleRunChecksCronRequest } from "../src/lib/core/cron-route-handler.ts"

const cronCredentialFixture = "fixture"

test("cron authorization requires an exact bearer secret", () => {
  assert.equal(isAuthorizedCronRequest(null, cronCredentialFixture), false)
  assert.equal(isAuthorizedCronRequest("Bearer wrong", cronCredentialFixture), false)
  assert.equal(isAuthorizedCronRequest("Basic fixture", cronCredentialFixture), false)
  assert.equal(isAuthorizedCronRequest("Bearer fixture", cronCredentialFixture), true)
})

test("scheduler SQL claims checks with skip locked and calls the protected cron route", () => {
  const sql = readFileSync(new URL("../supabase/maintainflow_scheduler.sql", import.meta.url), "utf8")

  assert.match(sql, /create or replace function public\.claim_due_checks/)
  assert.match(sql, /plugin_id text/)
  assert.match(sql, /config_json jsonb/)
  assert.match(sql, /check_updated_at timestamptz/)
  assert.match(sql, /workflow_updated_at timestamptz/)
  assert.match(sql, /c\.updated_at as check_updated_at/)
  assert.match(sql, /w\.updated_at as workflow_updated_at/)
  assert.match(sql, /for update of c skip locked/)
  assert.match(sql, /active_claim\.workflow_id = c\.workflow_id[\s\S]+active_claim\.lease_expires_at > now\(\)/)
  assert.match(sql, /candidate\.workflow_id = c\.workflow_id/)
  assert.match(sql, /limit greatest\(1, least\(coalesce\(max_batch, 5\), 5\)\)/)
  assert.match(sql, /greatest\(120, least\(coalesce\(lease_seconds, 180\), 900\)\)/)
  assert.match(sql, /revoke all on function public\.claim_due_checks\(integer, integer, text\) from authenticated/)
  assert.match(sql, /grant execute on function public\.claim_due_checks\(integer, integer, text\) to service_role/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-checks'/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-checks-2'/)
  assert.match(sql, /schedule text default '\* \* \* \* \*'/)
  assert.equal((sql.match(/timeout_milliseconds := 60000/g) ?? []).length, 7)
  assert.equal((sql.match(/'batchSize', 5/g) ?? []).length, 5)
  assert.equal((sql.match(/'batchSize', 10/g) ?? []).length, 2)
  assert.match(sql, /configure_maintainflow_scheduler_direct/)
  assert.match(sql, /\/api\/cron\/run-checks/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-evals'/)
  assert.match(sql, /\/api\/cron\/run-evals/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-deliver-eval-alerts'/)
  assert.match(sql, /\/api\/cron\/deliver-eval-alerts/)
  assert.match(sql, /Authorization/)
  assert.match(sql, /cron\.unschedule\('maintainflow-retry-pilot-lead-notifications'\)/)
  assert.doesNotMatch(sql, /\/api\/cron\/retry-lead-notifications/)
  assert.doesNotMatch(sql, /cron\.schedule\(\s*'maintainflow-retry-pilot-lead-notifications'/)
})

test("scheduled runner dispatches claimed checks through the plugin registry", () => {
  const source = readFileSync(new URL("../src/lib/core/scheduled-runner.ts", import.meta.url), "utf8")

  assert.match(source, /getCheckPlugin/)
  assert.match(source, /check\.plugin_id/)
  assert.match(source, /check\.config_json/)
  assert.match(source, /plugin\.normalizeResult/)
  assert.match(source, /sanitizeAssertionResults/)
  assert.match(source, /rpc\/record_assurance_check_result/)
  assert.match(source, /p_expected_check_updated_at: check\.check_updated_at/)
  assert.match(source, /p_expected_workflow_updated_at: check\.workflow_updated_at/)
  assert.match(source, /Promise\.all\(claimed\.map\(async \(check\) =>/)
  assert.match(source, /max_batch: Math\.max\(1, Math\.min\(input\.batchSize, 5\)\)/)
  assert.match(source, /lease_seconds: Math\.max\(120, Math\.min\(input\.leaseSeconds, 900\)\)/)
  assert.doesNotMatch(source, /supabaseServiceJson\("check_runs"/)
})

test("scheduled evidence and issue lifecycle commit through one atomic RPC", () => {
  const source = readFileSync(new URL("../src/lib/core/scheduled-runner.ts", import.meta.url), "utf8")

  assert.match(source, /await supabaseServiceJson<Array<\{ run_id\?: string \}>>\("rpc\/record_assurance_check_result"/)
  assert.match(source, /p_advance_schedule: true/)
  assert.doesNotMatch(source, /invalidateIssueResolutionsForCheckRun/)
  assert.doesNotMatch(source, /upsertIssueForCheckRun/)
})

test("persistence failure releases only the original lease without advancing schedule", () => {
  const source = readFileSync(new URL("../src/lib/core/scheduled-runner.ts", import.meta.url), "utf8")
  const releaseSource = source.slice(source.indexOf("async function releaseCheckLease"), source.indexOf("async function insertCheckJobRun"))

  assert.match(source, /await releaseCheckLease\(check\.check_id, check\.agency_id, check\.check_updated_at\)/)
  assert.match(releaseSource, /updated_at: `eq\.\$\{expectedUpdatedAt\}`/)
  assert.match(releaseSource, /lease_expires_at: null/)
  assert.match(releaseSource, /leased_by: null/)
  assert.doesNotMatch(releaseSource, /next_run_at/)
  assert.doesNotMatch(releaseSource, /last_run_at/)
})

test("scheduler verification SQL is read-only and checks the cron installation", () => {
  const sql = readFileSync(new URL("../supabase/maintainflow_scheduler_verify.sql", import.meta.url), "utf8")

  assert.match(sql, /pg_extension/)
  assert.match(sql, /claim_due_checks_rpc/)
  assert.match(sql, /claim_due_checks_return_contract/)
  assert.match(sql, /from cron\.job/)
  assert.match(sql, /scheduler_capacity_ready/)
  assert.match(sql, /maintainflow-run-checks-2/)
  assert.match(sql, /timeout_milliseconds\\s\*:=\\s\*60000/)
  assert.match(sql, /'''batchSize''\\s\*,\\s\*5/)
  assert.match(sql, /retired_paid_pilot_retry_job_absent/)
  assert.doesNotMatch(sql, /select\s+public\.claim_due_checks\(/i)
  assert.doesNotMatch(sql, /net\.http_post\(/)
})

test("cron route handler rejects unauthenticated requests before running checks", async () => {
  let runnerCalled = false
  const response = await handleRunChecksCronRequest({
    authorizationHeader: null,
    secret: cronCredentialFixture,
    body: {},
    runner: async () => {
      runnerCalled = true
      return {}
    },
  })

  assert.equal(response.status, 401)
  assert.equal(response.body.ok, false)
  assert.equal(runnerCalled, false)
})

test("cron route handler caps each launch worker to one concurrent five-check wave", async () => {
  const response = await handleRunChecksCronRequest({
    authorizationHeader: "Bearer fixture",
    secret: cronCredentialFixture,
    body: { batchSize: 7 },
    defaultLeaseSeconds: "240",
    runner: async (input) => ({
      workerId: "test-worker",
      claimed: input.batchSize,
      leaseSeconds: input.leaseSeconds,
    }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    ok: true,
    ranAt: response.body.ranAt,
    workerId: "test-worker",
    claimed: 5,
    leaseSeconds: 240,
  })
  assert.equal(typeof response.body.ranAt, "string")
})

test("capacity migration upgrades the installed command without needing the cron secret again", () => {
  const sql = readFileSync(new URL("../supabase/maintainflow_scheduler_capacity_migration.sql", import.meta.url), "utf8")

  assert.match(sql, /select command[\s\S]+where jobname = 'maintainflow-run-checks'/)
  assert.match(sql, /regexp_replace\([\s\S]+timeout_milliseconds := 60000/)
  assert.match(sql, /'''batchSize'', 1'/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-checks'/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-checks-2'/)
  assert.equal((sql.match(/'\* \* \* \* \*'/g) ?? []).length, 2)
  assert.doesNotMatch(sql, /replace-with|cron_secret|Authorization/)
})

test("contract capacity migration activates five-check waves after artifact proof", () => {
  const sql = readFileSync(new URL("../supabase/maintainflow_scheduler_capacity_contract_migration.sql", import.meta.url), "utf8")

  assert.match(sql, /'''batchSize'', 5'/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-checks'/)
  assert.match(sql, /cron\.schedule\(\s*'maintainflow-run-checks-2'/)
  assert.equal((sql.match(/'\* \* \* \* \*'/g) ?? []).length, 2)
  assert.doesNotMatch(sql, /replace-with|cron_secret|Authorization/)
})

test("cron route handler preserves a lease buffer beyond endpoint and persistence time", async () => {
  const response = await handleRunChecksCronRequest({
    authorizationHeader: "Bearer fixture",
    secret: cronCredentialFixture,
    body: {},
    defaultLeaseSeconds: "30",
    runner: async (input) => ({ leaseSeconds: input.leaseSeconds }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.leaseSeconds, 120)
})

test("cron route handler returns a clear skipped summary when no checks are due", async () => {
  const response = await handleRunChecksCronRequest({
    authorizationHeader: "Bearer fixture",
    secret: cronCredentialFixture,
    body: {},
    runner: async () => ({
      workerId: "test-worker",
      status: "skipped",
      claimed: 0,
      checksRun: 0,
      failures: 0,
      errors: [],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.status, "skipped")
  assert.equal(response.body.claimed, 0)
})
