import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { ordinaryClickLooksDestructive } from "../src/lib/runner/action-safety.ts"
import { classifyEmailTiming } from "../src/lib/runner/email-timing.ts"

const baseline = "2026-07-18T12:00:00.000Z"

test("email timing uses persisted submission completion for pre-arrived and waiting paths", () => {
  assert.deepEqual(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    receivedAt: "2026-07-18T12:00:45.000Z",
    nowMs: Date.parse("2026-07-18T12:01:00.000Z"),
  }), {
    status: "on_time",
    baselineAt: baseline,
    deadlineAt: "2026-07-18T12:02:00.000Z",
    receivedAt: "2026-07-18T12:00:45.000Z",
    latencyMs: 45_000,
  })
  assert.deepEqual(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    nowMs: Date.parse("2026-07-18T12:01:30.000Z"),
  }), {
    status: "pending",
    baselineAt: baseline,
    deadlineAt: "2026-07-18T12:02:00.000Z",
    remainingMs: 30_000,
  })
  assert.deepEqual(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    maximumWaitSeconds: 600,
    nowMs: Date.parse("2026-07-18T12:01:30.000Z"),
  }), {
    status: "pending",
    baselineAt: baseline,
    deadlineAt: "2026-07-18T12:10:00.000Z",
    remainingMs: 510_000,
  })
  assert.equal(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    maximumWaitSeconds: 600,
    receivedAt: "2026-07-18T12:02:00.001Z",
  }).status, "late")
  assert.equal(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    maximumWaitSeconds: 600,
    receivedAt: "2026-07-18T12:10:00.001Z",
  }).status, "too_late")
  assert.equal(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    nowMs: Date.parse("2026-07-18T12:02:00.000Z"),
  }).status, "timeout")
  assert.deepEqual(classifyEmailTiming({
    submissionCompletedAt: baseline,
    thresholdSeconds: 120,
    receivedAt: "2026-07-18T11:59:59.999Z",
  }), {
    status: "invalid",
    reason: "The signed inbound email predates the persisted submission completion.",
  })
})

test("ordinary browser clicks reject destructive and payment-like actions", () => {
  const click = (label: string, name: string) => ({
    id: "click",
    label,
    timeoutMs: 1_000,
    type: "click" as const,
    locator: { kind: "role" as const, role: "button", name },
  })
  assert.equal(ordinaryClickLooksDestructive(click("Submit", "Create account")), false)
  assert.equal(ordinaryClickLooksDestructive(click("Continue", "Delete account")), true)
  assert.equal(ordinaryClickLooksDestructive(click("Place order", "Confirm")), true)
  assert.equal(ordinaryClickLooksDestructive(click("Purchase", "Buy now")), true)
})

test("failure diagnostics are private summaries without request secrets", () => {
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(engine, /safeJsonArtifact\("dom_summary"/)
  assert.match(engine, /safeJsonArtifact\("network_summary"/)
  assert.match(engine, /pathHash: createHash\("sha256"\)\.update\(path\)/)
  assert.match(engine, /reportSafe: false/)
  assert.match(engine, /redacted: true/)
  assert.doesNotMatch(engine, /request\.headers\(|request\.postData\(|document\.documentElement\.outerHTML|document\.cookie/)
  assert.match(engine, /context\.tracing[\s\S]*\.start\(\{ screenshots: true, snapshots: true, sources: false \}\)/)
  assert.match(engine, /if \(diagnosticStageId\)[\s\S]*stopPlaywrightTraceArtifact/)
  assert.match(engine, /join\(directory, "trace\.zip"\)/)
  assert.match(engine, /contentType: "application\/zip"[\s\S]*reportSafe: false[\s\S]*redacted: false/)
  assert.match(engine, /if \(traceStarted\) await connected\.context\.tracing\.stop\(\)/)
})

test("durable browser session handles never serialize connection URLs or browser state", () => {
  const types = readFileSync("src/lib/runner/types.ts", "utf8")
  const handle = types.match(/export type BrowserSessionHandle = \{([\s\S]*?)\n\}/)?.[1] ?? ""
  assert.doesNotMatch(handle, /connectUrl|cookie|storageState|token/i)

  const browserbase = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  assert.match(browserbase, /sessions\.retrieve\(session\.sessionId\)/)
  assert.match(browserbase, /chromium\.connectOverCDP\(connectUrl\)/)

  const local = readFileSync("src/lib/runner/local-playwright-provider.server.ts", "utf8")
  assert.match(local, /new Map<string, LocalSessionState>/)
  assert.match(local, /storageState: await context\.storageState\(\)/)
  assert.match(local, /storageState: saved\.storageState/)
  assert.match(local, /return `\$\{url\.origin\}\$\{url\.pathname\}`/)
})

test("unique workflow attempts own preflight finalization and submission timing is persisted", () => {
  const dispatch = readFileSync("src/lib/workflows/dispatch-eval-run.server.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  assert.match(dispatch, /workflowAttemptToken = crypto\.randomUUID\(\)/)
  assert.match(dispatch, /start\(runBusinessEvalWorkflow, \[\{[\s\S]*workflowAttemptToken/)
  assert.match(workflow, /workflow:\$\{input\.evalRunId\}:\$\{input\.workflowAttemptToken\}/)
  assert.match(workflow, /String\(run\.worker_id \?\? ""\) !== workerId/)
  assert.match(workflow, /preflightFinalized: false/)
  assert.match(workflow, /rpc\/complete_eval_run_side_effect_phase_at/)
  assert.match(workflow, /submissionCompletedAt[\s\S]*classifyEmailTiming/)
  assert.match(workflow, /degradedEmailStage/)
  assert.match(workflow, /maximumWaitSeconds: context\.emailMaximumWaitSeconds/)
  assert.match(workflow, /EMAIL_MAXIMUM_WAIT_EXCEEDED/)
})
