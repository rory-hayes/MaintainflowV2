import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { inProductCleanupLooksLikeAccountDeletion, ordinaryClickLooksDestructive } from "../src/lib/runner/action-safety.ts"
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

test("in-product cleanup requires an explicit account-deletion button", () => {
  const cleanup = (label: string, role: string, name: string) => ({
    id: "cleanup",
    label,
    timeoutMs: 1_000,
    type: "cleanup" as const,
    mode: "in_product" as const,
    locator: { kind: "role" as const, role, name },
  })
  assert.equal(inProductCleanupLooksLikeAccountDeletion(cleanup("Delete synthetic test account", "button", "Delete test account")), true)
  assert.equal(inProductCleanupLooksLikeAccountDeletion(cleanup("Continue", "button", "Continue")), false)
  assert.equal(inProductCleanupLooksLikeAccountDeletion(cleanup("Delete account", "link", "Delete account")), false)
  assert.equal(inProductCleanupLooksLikeAccountDeletion(cleanup("Delete account", "button", "Confirm payment")), false)
})

test("runner proves assertion uniqueness before waiting for visibility and rechecks after", () => {
  const runner = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  const start = runner.indexOf("async function waitForUniqueVisibleAssertion")
  const end = runner.indexOf("async function failDeterministicAssertionTimeout", start)
  const body = runner.slice(start, end)
  const attached = body.indexOf('state: "attached"')
  const count = body.indexOf("const count = await locator.count()", attached)
  const visible = body.indexOf('state: "visible"', count)
  const visibleCount = body.indexOf("const visibleCount = await locator.count()", visible)
  assert.ok(attached >= 0 && attached < count)
  assert.ok(count < visible && visible < visibleCount)
})

test("page scans revalidate the final URL and block all mutation-class requests", () => {
  const scan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")
  const safety = readFileSync("src/lib/runner/browser-safety.server.ts", "utf8")
  assert.match(scan, /installTopLevelNavigationGuard\(connection\.page, allowedDomains, connection\.networkMode, \{ blockSideEffects: true \}\)/)
  assert.match(scan, /await assertNavigationStayedPublic\(connection\.page, allowedDomains\)/)
  assert.match(scan, /url: \(await assertNavigationStayedPublic\(connection\.page, allowedDomains\)\)\.url\.toString\(\)/)
  assert.match(safety, /guards\.blockSideEffects && isSideEffectingRequest\(request\)/)
  assert.match(safety, /SIDE_EFFECT_BLOCKED/)
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
  assert.match(handle, /contextId: string/)
  assert.match(handle, /lastSessionId: string \| null/)
  assert.match(handle, /resumeUrl: string \| null/)
  assert.match(handle, /readyAt: string/)
  assert.doesNotMatch(handle, /connectUrl|cookie|storageState|token|allowedHosts|expiresAt/i)

  const browserbase = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  assert.match(browserbase, /contexts\.create\(\{ projectId: this\.projectId \}\)/)
  assert.match(browserbase, /keepAlive: false/)
  assert.match(browserbase, /context: \{ id: session\.contextId, persist: true \}/)
  assert.match(browserbase, /chromium\.connectOverCDP\(created\.connectUrl\)/)

  const local = readFileSync("src/lib/runner/local-playwright-provider.server.ts", "utf8")
  assert.match(local, /new Map<string, LocalContextState>/)
  assert.match(local, /state\.storageState = await context\.storageState\(\)/)
  assert.match(local, /state\.storageState \? \{ storageState: state\.storageState \}/)
  assert.match(local, /lastSessionId = `local-session-\$\{crypto\.randomUUID\(\)\}`/)
  assert.match(local, /sanitizeBrowserResumeUrl\(page\.url\(\), input\.allowedHosts\)/)
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
