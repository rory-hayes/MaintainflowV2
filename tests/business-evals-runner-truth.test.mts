import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { classifyEmailReceivingHealth, EMAIL_RECEIVING_HEALTH_FRESHNESS_MS } from "../src/lib/email/receiving-health.ts"
import {
  assertRequiredAssertionResultsAlign,
  createRunnerAssertionResult,
  DETERMINISTIC_EVALUATOR_VERSION,
} from "../src/lib/runner/assertion-results.ts"
import { isPlaywrightTimeoutError } from "../src/lib/runner/assertion-truth.ts"

test("only a Playwright timeout at a deterministic assertion is eligible for a failed miss", () => {
  const timeout = new Error("locator did not become visible")
  timeout.name = "TimeoutError"
  assert.equal(isPlaywrightTimeoutError(timeout), true)
  assert.equal(isPlaywrightTimeoutError(new Error("browser disconnected")), false)
  assert.equal(isPlaywrightTimeoutError("TimeoutError"), false)

  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(engine, /URL_ASSERTION_NOT_MET/)
  assert.match(engine, /VISIBLE_ASSERTION_NOT_MET/)
  assert.match(engine, /!isPlaywrightTimeoutError\(input\.error\) \|\| input\.page\.isClosed\(\)/)
  assert.match(engine, /ACCESS_BLOCKED[\s\S]*inconclusive/)
  assert.match(engine, /CAPTCHA_DETECTED[\s\S]*inconclusive/)
  assert.match(engine, /AMBIGUOUS_LOCATOR[\s\S]*inconclusive/)
})

test("email absence is conclusive only with a real fresh receiving observation covering the deadline", () => {
  const submissionCompletedAt = "2026-07-18T12:00:00.000Z"
  const maximumWaitSeconds = 600
  assert.equal(EMAIL_RECEIVING_HEALTH_FRESHNESS_MS, 300_000)
  assert.deepEqual(classifyEmailReceivingHealth({
    submissionCompletedAt,
    maximumWaitSeconds,
    observedAt: "2026-07-18T12:06:00.000Z",
  }), {
    status: "healthy",
    observedAt: "2026-07-18T12:06:00.000Z",
  })
  assert.equal(classifyEmailReceivingHealth({
    submissionCompletedAt,
    maximumWaitSeconds,
    observedAt: "2026-07-18T12:04:59.999Z",
  }).status, "unknown")
  assert.equal(classifyEmailReceivingHealth({
    submissionCompletedAt,
    maximumWaitSeconds,
    observedAt: "2026-07-18T12:10:00.001Z",
  }).status, "unknown")
  assert.equal(classifyEmailReceivingHealth({ submissionCompletedAt, maximumWaitSeconds }).status, "unknown")
  assert.equal(classifyEmailReceivingHealth({
    submissionCompletedAt,
    maximumWaitSeconds: 120,
    observedAt: "2026-07-18T11:58:30.000Z",
  }).status, "healthy")
})

test("Resend health is derived from signed webhook content retrieval and stored service-only", () => {
  const inbound = readFileSync("src/lib/email/resend-inbound.server.ts", "utf8")
  const health = readFileSync("src/lib/email/resend-receiving-health.server.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")

  assert.ok(inbound.indexOf("resend.emails.receiving.get") < inbound.indexOf("await recordResendReceivingHealth"))
  assert.match(health, /provider_event_id_hash/)
  assert.match(health, /resolution=ignore-duplicates/)
  assert.match(workflow, /EMAIL_RECEIVING_HEALTH_UNKNOWN/)
  assert.match(workflow, /receivingHealth\.status === "healthy"[\s\S]*timedEmailFailureStage/)
  assert.match(migration, /create table if not exists public\.eval_email_receiving_health_events/)
  assert.match(migration, /revoke all on table public\.eval_email_receiving_health_events from public, anon, authenticated/)
  assert.match(migration, /grant select, insert, update, delete on public\.eval_email_receiving_health_events to service_role/)
})

test("every business-eval stage emits a typed deterministic assertion aligned with its verdict", () => {
  const result = createRunnerAssertionResult({
    assertionId: "stage:success",
    required: true,
    expectedRule: "The success state is visible.",
    safeObservation: "The success state did not appear within 10 seconds.",
    result: "failed",
    evaluatedAt: "2026-07-18T12:00:10.000Z",
  })
  assert.deepEqual(result, {
    assertionId: "stage:success",
    required: true,
    expectedRule: "The success state is visible.",
    safeObservation: "The success state did not appear within 10 seconds.",
    observationDigest: "5656f126dc0d9cdbc487344fefc6bd24d9f7854f2d5b5948ce3892df18c4e189",
    result: "failed",
    evaluatedAt: "2026-07-18T12:00:10.000Z",
    evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
  })
  assert.doesNotThrow(() => assertRequiredAssertionResultsAlign("failed", [result]))
  assert.throws(
    () => assertRequiredAssertionResultsAlign("passed", [result]),
    /does not match its stage verdict/
  )
  assert.throws(() => assertRequiredAssertionResultsAlign("failed", []), /requires a deterministic assertion/)

  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  assert.match(engine, /assertionResults: \[stageAssertion\(stage, verdict, observed, completedAt\)\]/)
  assert.match(engine, /assertionResults: \[stageAssertion\(stage, "not_run", observed, at\)\]/)
  assert.match(workflow, /assertionResults: \[createRunnerAssertionResult\(/)
  assert.doesNotMatch(workflow, /assertionResults:\s*\[\]/)
})
