import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { businessEvalJourneyEntitlementViolation } from "../src/lib/billing/business-eval-journey-entitlement.ts"
import {
  assertRequiredAssertionResultsAlign,
  createRunnerAssertionResult,
  reclassifyRunnerAssertionResults,
} from "../src/lib/runner/assertion-results.ts"
import {
  assertionTransitionViolation,
  urlMatchesPublishedPattern,
} from "../src/lib/runner/assertion-transition.ts"
import { selectUnambiguousSubmitActions } from "../src/lib/runner/page-scan-actions.ts"

test("late cancellation reclassifies required assertions before durable finalization", () => {
  const passed = createRunnerAssertionResult({
    assertionId: "stage:submit",
    required: true,
    expectedRule: "The marked lead form submits once.",
    safeObservation: "The submission completed deterministically.",
    result: "passed",
    evaluatedAt: "2026-07-19T09:00:00.000Z",
  })
  const cancelled = reclassifyRunnerAssertionResults([passed], "cancelled")

  assert.equal(passed.result, "passed", "reclassification must not mutate the completed evidence object")
  assert.equal(cancelled[0]?.result, "cancelled")
  assert.doesNotThrow(() => assertRequiredAssertionResultsAlign("cancelled", cancelled))

  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  assert.match(workflow, /reclassifyRunnerAssertionResults\(result\.assertionResults, "cancelled"\)/)
})

test("page scans expose only unique enabled form-associated submit controls", () => {
  const actions = selectUnambiguousSubmitActions([
    { index: 0, tag: "a", inputType: "", hasForm: false, disabled: false, label: "Thank you" },
    { index: 1, tag: "div", inputType: "", hasForm: true, disabled: false, label: "Pretend submit" },
    { index: 2, tag: "button", inputType: "button", hasForm: true, disabled: false, label: "Open help" },
    { index: 3, tag: "button", inputType: "submit", hasForm: false, disabled: false, label: "Detached submit" },
    { index: 4, tag: "button", inputType: "submit", hasForm: true, disabled: true, label: "Disabled submit" },
    { index: 5, tag: "button", inputType: "submit", hasForm: true, disabled: false, label: "Submit lead" },
    { index: 6, tag: "input", inputType: "image", hasForm: true, disabled: false, label: "Create trial" },
    { index: 7, tag: "button", inputType: "submit", hasForm: true, disabled: false, label: "Duplicate" },
    { index: 8, tag: "button", inputType: "submit", hasForm: true, disabled: false, label: "Duplicate" },
  ])

  assert.deepEqual(actions.map((action) => action.label), ["Submit lead", "Create trial"])
  assert.ok(actions.every((action) => action.role === "button" && action.locator.role === "button"))

  const scan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")
  assert.doesNotMatch(scan, /a\[href\]|\[role=button\]/)
})

test("business and cleanup assertions require a false pre-action baseline", () => {
  assert.equal(assertionTransitionViolation({
    satisfiedBeforeAction: false,
    sourceActionId: "submit",
    capturedAt: "2026-07-19T09:00:00.000Z",
  }), null)
  assert.equal(assertionTransitionViolation(undefined)?.code, "TRANSITION_BASELINE_MISSING")
  assert.equal(assertionTransitionViolation({
    satisfiedBeforeAction: null,
    sourceActionId: "submit",
    capturedAt: "2026-07-19T09:00:00.000Z",
  })?.code, "TRANSITION_BASELINE_UNAVAILABLE")
  assert.equal(assertionTransitionViolation({
    satisfiedBeforeAction: true,
    sourceActionId: "delete_test_account",
    capturedAt: "2026-07-19T09:00:00.000Z",
  })?.code, "PREEXISTING_ASSERTION_STATE")

  assert.equal(urlMatchesPublishedPattern("https://example.com/thanks", "https://example.com/thanks"), true)
  assert.equal(urlMatchesPublishedPattern("https://example.com/thanks/123", "https://example.com/thanks/*"), true)
  assert.equal(urlMatchesPublishedPattern("https://example.com/form", "https://example.com/thanks/*"), false)

  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  const submitCheck = engine.indexOf("await assertFormSubmitControl(locator)")
  const baselineCapture = engine.indexOf("await captureTransitionBaselines(page, pageObservation, action.id)", submitCheck)
  const click = engine.indexOf("await locator.click({ timeout })", baselineCapture)
  assert.ok(submitCheck >= 0 && baselineCapture > submitCheck && click > baselineCapture)
  for (const actionType of ["wait_for_url", "wait_for_text", "assert_visible"]) {
    const branch = engine.indexOf(`case "${actionType}"`)
    const guard = engine.indexOf("requirePostActionTransition(pageObservation, action)", branch)
    assert.ok(branch >= 0 && guard > branch, `${actionType} must require a pre/post transition`)
  }
})

test("current plan features gate Trial signup and email journeys at every execution boundary", () => {
  const free = { email: false } as const
  const paid = { email: true } as const
  assert.equal(businessEvalJourneyEntitlementViolation({ template: "lead_form", emailProofConfigured: false }, free), null)
  assert.equal(businessEvalJourneyEntitlementViolation({ template: "legacy_endpoint", emailProofConfigured: false }, free), null)
  assert.equal(businessEvalJourneyEntitlementViolation({ template: "lead_form", emailProofConfigured: true }, free)?.code, "EMAIL_EVALS_PAID_PLAN_REQUIRED")
  assert.equal(businessEvalJourneyEntitlementViolation({ template: "trial_signup", emailProofConfigured: false }, free)?.code, "EMAIL_EVALS_PAID_PLAN_REQUIRED")
  assert.equal(businessEvalJourneyEntitlementViolation({ template: "trial_signup", emailProofConfigured: true }, paid), null)

  const manual = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
  const manualReplay = manual.indexOf("const replay = await findExistingEvalRunReplay")
  const manualEntitlement = manual.indexOf("await enforcePublishedJourneyFeatureEntitlement")
  assert.ok(manualReplay >= 0 && manualEntitlement > manualReplay, "manual replay must remain ahead of entitlement work")

  const scheduled = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
  const scheduledReplay = scheduled.indexOf("const replay = await findExistingEvalRunReplay")
  const scheduledEntitlement = scheduled.indexOf("await enforcePublishedJourneyFeatureEntitlement")
  assert.ok(scheduledReplay >= 0 && scheduledEntitlement > scheduledReplay, "scheduled replay must remain ahead of entitlement work")
  assert.match(scheduled, /error\.code === "EMAIL_EVALS_PAID_PLAN_REQUIRED"/)

  const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  const scheduleFunction = journeys.slice(journeys.indexOf("export async function configureJourneySchedule"))
  assert.match(scheduleFunction, /if \(input\.enabled\)[\s\S]+enforcePublishedJourneyFeatureEntitlement/)
  assert.match(journeys, /journey\.pauseReason === "entitlement_lost"[\s\S]+enforcePublishedJourneyFeatureEntitlement/)

  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const pauseRpc = migration.slice(
    migration.indexOf("create or replace function public.pause_business_eval_journey_for_entitlement_loss"),
    migration.indexOf("create or replace function public.claim_due_journey_schedules")
  )
  assert.match(pauseRpc, /update public\.workflows[\s\S]+pause_reason = case[\s\S]+entitlement_lost/)
  assert.match(pauseRpc, /update public\.journey_schedules set[\s\S]+enabled = false[\s\S]+lease_expires_at = null[\s\S]+leased_by = null/)
  assert.match(migration, /revoke all on function public\.pause_business_eval_journey_for_entitlement_loss\(uuid,uuid\)[\s\S]+grant execute[\s\S]+to service_role/)
})

test("project and journey writes are service-only while authenticated legacy reads remain available", () => {
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")

  assert.match(migration, /drop policy if exists clients_members_all on public\.clients;[\s\S]+create policy clients_members_select on public\.clients[\s\S]+for select to authenticated/)
  assert.match(migration, /drop policy if exists workflows_members_all on public\.workflows;[\s\S]+create policy workflows_members_select on public\.workflows[\s\S]+for select to authenticated/)
  assert.match(migration, /revoke insert, update, delete on public\.clients, public\.workflows from authenticated;/)
  assert.match(migration, /grant select on public\.clients, public\.workflows to authenticated;/)
})

test("evidence upload failures compensate storage and retention still runs while scheduling is paused", () => {
  const storage = readFileSync("src/lib/runner/evidence-storage.server.ts", "utf8")
  assert.match(storage, /export async function deletePrivateEvalArtifact\(storagePath: string\)/)
  assert.match(storage, /method: "DELETE"[\s\S]+JSON\.stringify\(\{ prefixes: \[storagePath\] \}\)/)

  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  const metadataInsert = workflow.indexOf('await supabaseServiceJson("evidence_artifacts"')
  const metadataCatch = workflow.indexOf("catch (metadataError)", metadataInsert)
  const objectDelete = workflow.indexOf("await deletePrivateEvalArtifact(stored.storagePath)", metadataCatch)
  const idRegistration = workflow.indexOf("idsByStage.set", objectDelete)
  assert.ok(metadataInsert >= 0 && metadataCatch > metadataInsert && objectDelete > metadataCatch && idRegistration > objectDelete)

  const scheduler = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
  const retention = scheduler.indexOf("await purgeExpiredEvalEvidence(50)")
  const killSwitch = scheduler.indexOf("BUSINESS_EVALS_SCHEDULER_KILL_SWITCH")
  assert.ok(retention >= 0 && killSwitch > retention, "retention must run before any scheduler or runner pause return")
  assert.doesNotMatch(scheduler, /evidenceRetention: \{ skipped: true \}/)
})
