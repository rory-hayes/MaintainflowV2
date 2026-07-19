import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { isBusinessEvalsRunnerEnabled } from "../src/lib/features/business-evals.ts"

const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const canonical = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
const dispatch = readFileSync("src/lib/workflows/dispatch-eval-run.server.ts", "utf8")
const scheduler = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
const browserSafety = readFileSync("src/lib/runner/browser-safety.server.ts", "utf8")
const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")

test("runner kill-switch values fail closed across supported deployment flag forms", () => {
  for (const value of ["1", "true", "enabled", " TRUE "]) {
    assert.equal(isBusinessEvalsRunnerEnabled({
      BUSINESS_EVALS_RUNNER_ENABLED: "true",
      BUSINESS_EVALS_RUNNER_KILL_SWITCH: value,
    }), false)
  }
  assert.equal(isBusinessEvalsRunnerEnabled({
    BUSINESS_EVALS_RUNNER_ENABLED: "enabled",
    BUSINESS_EVALS_RUNNER_KILL_SWITCH: "false",
  }), true)
})

for (const [label, sql] of [["migration", migration], ["canonical schema", canonical]] as const) {
  test(`${label} atomically terminalizes a dispatch-owned run before execution`, () => {
    const rpc = sql.slice(
      sql.indexOf("create or replace function public.cancel_business_eval_run_before_execution"),
      sql.indexOf("create or replace function public.claim_due_business_eval_runs")
    )
    assert.match(rpc, /dispatch_state <> 'dispatching'/)
    assert.match(rpc, /dispatch_worker_id <> trim\(coalesce\(p_dispatch_worker_id, ''\)\)/)
    assert.match(rpc, /not exists|exists \([\s\S]+eval_run_side_effect_attempts/)
    assert.match(rpc, /status = 'cancelled'/)
    assert.match(rpc, /verdict = 'cancelled'/)
    assert.match(rpc, /cleanup_status = 'skipped'/)
    assert.match(rpc, /quota_counted = false/)
    assert.match(rpc, /next_run_at = stopped_at \+ make_interval/)
    assert.match(sql, /revoke all on function public\.cancel_business_eval_run_before_execution\(uuid,uuid,text,text\)[\s\S]+grant execute[\s\S]+to service_role/)
  })

  test(`${label} makes CAPTCHA inconclusive and atomically pauses the journey and schedule`, () => {
    const finalize = sql.slice(
      sql.indexOf("create or replace function public.finalize_business_eval_run"),
      sql.indexOf("create or replace function public.create_business_eval_report_snapshot")
    )
    assert.match(finalize, /item->>'errorCode' = 'CAPTCHA_DETECTED'/)
    assert.match(finalize, /if captcha_detected then[\s\S]+computed_verdict := 'inconclusive'/)
    assert.match(finalize, /if captcha_detected or derived_cleanup_status = 'failed' then/)
    assert.match(finalize, /update public\.workflows set[\s\S]+pause_reason = case when captcha_detected then 'captcha_detected'/)
    assert.match(finalize, /update public\.journey_schedules set[\s\S]+enabled = false[\s\S]+pause_reason = case when captcha_detected then 'captcha_detected'/)
    assert.match(finalize, /cleanup_status = derived_cleanup_status/)
  })

  test(`${label} charges every immutable configured destination domain`, () => {
    const enqueue = sql.slice(
      sql.indexOf("create or replace function public.enqueue_business_eval_run"),
      sql.indexOf("create or replace function public.claim_eval_run_for_dispatch")
    )
    assert.match(enqueue, /for destination_domain in/)
    assert.match(enqueue, /action->>'type' = 'navigate'[\s\S]+action->>'url'/)
    assert.match(enqueue, /action->>'type' = 'cleanup' and action->>'mode' = 'webhook'[\s\S]+action->>'webhookUrl'/)
    assert.match(enqueue, /action->>'type' = 'open_email_link'[\s\S]+action#>>'\{linkRule,host\}'/)
    assert.match(enqueue, /consume_business_eval_rate_limit\([\s\S]+destination_domain/)
  })
}

test("dispatch and every durable side-effect boundary recheck the global controls", () => {
  const dispatchGuard = dispatch.indexOf("if (!isBusinessEvalsRunnerEnabled() || scheduledExecutionPaused)")
  const workflowStart = dispatch.indexOf("start(runBusinessEvalWorkflow")
  assert.ok(dispatchGuard >= 0 && workflowStart > dispatchGuard)
  assert.match(dispatch, /rpc\/cancel_business_eval_run_before_execution/)
  assert.match(dispatch, /BUSINESS_EVALS_SCHEDULER_KILL_SWITCH/)

  assert.match(workflow, /assertRunnerExecutionAllowed\(context\.triggerSource\)[\s\S]+rpc\/begin_eval_run_side_effect_phase/)
  assert.match(workflow, /assertExecutionAllowed: async \(\) => assertRunnerExecutionAllowed\(context\.triggerSource\)/)
  assert.match(workflow, /BUSINESS_EVALS_SCHEDULER_KILL_SWITCH/)
  assert.match(engine, /await assertExecutionAllowed\?\.\(\)[\s\S]+await locator\.click/)
  const pauseBranch = scheduler.indexOf("if (runnerPaused || schedulerPaused)")
  const pausedRecovery = scheduler.indexOf("await recoverPendingEvalRunDispatches(5)", pauseBranch)
  const pausedReturn = scheduler.indexOf("paused: true", pauseBranch)
  assert.ok(pauseBranch >= 0 && pausedRecovery > pauseBranch && pausedReturn > pausedRecovery)
})

test("actual form, verification, and cleanup destinations share denylist, SSRF, and persistent rate limits", () => {
  assert.match(browserSafety, /const requiresAuthorization = requiresDestinationAuthorization\(request\)/)
  assert.match(browserSafety, /await assertPublicBrowserTarget\(request\.url\(\), allowedHosts\)/)
  assert.match(browserSafety, /await guards\.assertExecutionAllowed\?\.\(\)/)
  assert.match(browserSafety, /guards\.consumeDestination\(target\.url\)/)
  assert.match(browserSafety, /configuredDomainDenylist\(\)/)

  const cleanup = workflow.slice(workflow.indexOf("async function callCleanupWebhook"), workflow.indexOf("function assertRunnerExecutionAllowed"))
  const publicTarget = cleanup.indexOf("await assertPublicBrowserTarget(target, context.allowedHosts)")
  const destinationLimit = cleanup.indexOf("await enforceBusinessEvalDestinationRateLimit(safety.url.hostname)")
  const post = cleanup.indexOf("await pinnedEndpointFetch")
  assert.ok(publicTarget >= 0 && destinationLimit > publicTarget && post > destinationLimit)
  assert.match(workflow, /consumeDestination: async \(url\) => enforceBusinessEvalDestinationRateLimit\(url\.hostname\)/)
})
