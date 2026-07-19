import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { enqueueEvalRunSchema } from "../src/lib/api/business-evals-contracts.ts"

const journeyId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"

test("debug is a first-class eval-run contract trigger", () => {
  assert.deepEqual(enqueueEvalRunSchema.parse({ journeyId, mode: "debug" }), {
    journeyId,
    mode: "debug",
  })
  assert.equal(enqueueEvalRunSchema.parse({ journeyId }).mode, "manual")
  assert.equal(enqueueEvalRunSchema.safeParse({ journeyId, mode: "arbitrary" }).success, false)

  const service = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
  const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  assert.match(service, /p_trigger_source: input\.run\.mode/)
  assert.match(service, /trigger: input\.run\.mode/)
  assert.match(service, /trigger: String\(row\.trigger_source\)/)
  assert.match(journeys, /trigger: String\(run\.trigger_source\)/)
  assert.match(service, /p_monthly_limit: entitlement\.runLimit/)
})

test("debug is persisted by the canonical quota-counted enqueue contract", () => {
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const schema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
  for (const sql of [migration, schema]) {
    assert.match(sql, /eval_runs_trigger_valid[\s\S]*?'debug'/)
    assert.match(sql, /p_trigger_source not in \('manual', 'supervised', 'verification', 'debug', 'scheduled', 'api', 'legacy_backfill'\)/)
  }

  const enqueueRpc = migration.match(/create or replace function public\.enqueue_business_eval_run\([\s\S]*?\n\$\$;/)?.[0] ?? ""
  assert.match(enqueueRpc, /trigger_source, idempotency_key[\s\S]*?p_trigger_source, p_idempotency_key/)
  assert.match(enqueueRpc, /where agency_id = p_agency_id and quota_counted and quota_period_start/)
  assert.doesNotMatch(enqueueRpc, /p_trigger_source\s*=\s*'debug'[\s\S]{0,160}quota_counted\s*=\s*false/)
})

test("debug runs retain private traces only when a stage fails or is inconclusive", () => {
  const types = readFileSync("src/lib/runner/types.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")

  assert.match(types, /export type RunnerTraceMode = "diagnostic"/)
  assert.match(types, /traceMode: RunnerTraceMode/)
  assert.match(workflow, /journey_version_id,trigger_source,synthetic_marker/)
  assert.equal((workflow.match(/traceMode: "diagnostic"/g) ?? []).length, 2)

  assert.match(engine, /const retainedTraceStageId = diagnosticStageId/)
  assert.doesNotMatch(engine, /traceMode === "always"/)
  assert.doesNotMatch(engine, /DEBUG_TRACE_RETENTION_FAILED/)
  assert.match(engine, /contentType: "application\/zip"[\s\S]*?reportSafe: false[\s\S]*?redacted: false/)
  assert.match(engine, /if \(traceStarted\) await connected\.context\.tracing\.stop\(\)/)
})

test("the Option 2 Journey control requests an actual debug run", () => {
  const page = readFileSync("src/components/evals/pages/journey-detail-page.tsx", "utf8")
  const provider = readFileSync("src/components/evals/evals-provider.tsx", "utf8")
  const adapters = readFileSync("src/components/evals/api-adapters.ts", "utf8")

  assert.match(page, /onRun\("debug"\)/)
  assert.match(page, />Run with debug capture<\/button>/)
  assert.match(provider, /InteractiveEvalRunMode/)
  assert.match(provider, /runMode === "debug" \? "Debug capture"/)
  assert.match(provider, /const duration = previewStageDuration\(stage\.id\)/)
  assert.match(provider, /observed: previewPassingObservation\(stage\.id, stage\.name\)/)
  assert.match(adapters, /mode: InteractiveEvalRunMode/)
})
