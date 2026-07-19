import assert from "node:assert/strict"
import test from "node:test"

import type { Agency, Client, Workflow } from "../src/lib/core/types.ts"
import {
  DEFAULT_EVAL_INTERVAL_MINUTES,
  MIN_TRIAL_SIGNUP_INTERVAL_MINUTES,
  assertJourneyCleanupPolicy,
  isSyntheticMarker,
  journeyFromWorkflow,
  journeyTemplateDefinition,
  normalizeEvalSchedulePolicy,
  projectFromClient,
  quotaPeriodStart,
  redactSensitiveText,
  redactSensitiveValue,
  reduceEvalVerdicts,
  scheduleStateAfterCleanup,
  syntheticEmail,
  syntheticMarker,
  validateActionManifest,
  workspaceFromAgency,
} from "../src/lib/evals/index.ts"

test("verdict reducer has one deterministic precedence for every runner outcome", () => {
  assert.equal(reduceEvalVerdicts([]), "not_run")
  assert.equal(reduceEvalVerdicts(["passed", "passed"]), "passed")
  assert.equal(reduceEvalVerdicts(["passed", "cancelled"]), "cancelled")
  assert.equal(reduceEvalVerdicts(["cancelled", "degraded"]), "degraded")
  assert.equal(reduceEvalVerdicts(["degraded", "inconclusive"]), "inconclusive")
  assert.equal(reduceEvalVerdicts(["inconclusive", "failed"]), "failed")
  assert.equal(reduceEvalVerdicts(["passed", "not_run"]), "not_run")
})

test("action manifests allow semantic targets and reject executable selectors", () => {
  const manifest = validateActionManifest({
    actions: [
      { id: "open", label: "Open signup", timeoutMs: 10_000, type: "navigate", url: "https://example.com/signup" },
      { id: "email", label: "Fill email", timeoutMs: 10_000, type: "fill", locator: { kind: "label", value: "Email" }, valueKey: "email" },
      { id: "submit", label: "Submit", timeoutMs: 10_000, type: "click", locator: { kind: "role", role: "button", name: "Submit" } },
    ],
  })
  assert.equal(manifest.actions.length, 3)
  assert.throws(() => validateActionManifest({ actions: [{ id: "css", label: "Click", timeoutMs: 1_000, type: "click", locator: { kind: "css", value: "#submit" } }] }), /Only role/)
  assert.throws(() => validateActionManifest({ actions: [{ id: "script", label: "Run", timeoutMs: 1_000, type: "script", javascript: "document.cookie" }] }), /CSS selectors/)
  assert.throws(() => validateActionManifest({ actions: [{ id: "fill", label: "Fill", timeoutMs: 1_000, type: "fill", locator: { kind: "label", value: "Email" }, valueKey: "" }] }), /synthetic value key/)
  assert.throws(() => validateActionManifest({ actions: [{ id: "open", label: "Open", timeoutMs: 1_000, type: "navigate", url: "https://localhost/signup" }] }), /public hostname/)
})

test("the three supported templates are restricted manifests and trial signup ends with cleanup", () => {
  const startUrl = "https://app.example.com/signup"
  for (const template of ["lead_form", "trial_signup", "legacy_endpoint"] as const) {
    const definition = journeyTemplateDefinition(template, startUrl)
    assert.equal(definition.template, template)
    assert.ok(definition.stages.length > 0)
    definition.stages.forEach((stage) => assert.deepEqual(validateActionManifest({ actions: stage.actions }).actions, stage.actions))
    assert.doesNotThrow(() => assertJourneyCleanupPolicy(definition))
  }
  const trial = journeyTemplateDefinition("trial_signup", startUrl)
  assert.equal(trial.stages.at(-1)?.cleanup, true)
  assert.throws(
    () => assertJourneyCleanupPolicy({ ...trial, stages: trial.stages.slice(0, -1) }),
    /cleanup stage/,
  )
})

test("scheduling defaults daily, enforces template floors, and pauses after cleanup failure", () => {
  assert.equal(normalizeEvalSchedulePolicy().intervalMinutes, DEFAULT_EVAL_INTERVAL_MINUTES)
  assert.equal(normalizeEvalSchedulePolicy({ intervalMinutes: 60 }, "lead_form").intervalMinutes, 60)
  assert.throws(
    () => normalizeEvalSchedulePolicy({ intervalMinutes: MIN_TRIAL_SIGNUP_INTERVAL_MINUTES - 1 }, "trial_signup"),
    /360/,
  )
  assert.deepEqual(scheduleStateAfterCleanup("failed"), { enabled: false, pauseReason: "cleanup_failed" })
  assert.deepEqual(scheduleStateAfterCleanup("passed"), { enabled: true, pauseReason: "" })
  assert.equal(quotaPeriodStart("2026-07-18T12:00:00Z"), "2026-07-01")
})

test("synthetic markers are stable and evidence redaction removes secrets and PII", () => {
  const marker = syntheticMarker("019f7576-dbaa-7a02-9787-d0f9a03b48e4")
  assert.ok(isSyntheticMarker(marker))
  assert.equal(syntheticEmail(marker), `${marker}@evals.maintainflow.test`)
  assert.equal(
    redactSensitiveText("Email buyer@example.com token Bearer abc.def and +353 87 123 4567"),
    "Email [REDACTED_EMAIL] token Bearer [REDACTED] and [REDACTED_PHONE]",
  )
  assert.deepEqual(redactSensitiveValue({ password: "hunter2", nested: { email: "buyer@example.com" } }), {
    password: "[REDACTED]",
    nested: { email: "[REDACTED_EMAIL]" },
  })
})

test("legacy physical records adapt to Workspace, Project, and Journey without data loss", () => {
  const agency = {
    id: "agency-1", name: "Studio", slug: "studio", plan: "free", trialEndsAt: null,
    stripeCustomerId: "", stripeSubscriptionId: "", reportSenderName: "Alex", reportSenderEmail: "alex@example.com",
    createdAt: "2026-07-18T00:00:00Z", updatedAt: "2026-07-18T00:00:00Z",
  } satisfies Agency
  const client = {
    id: "client-1", agencyId: agency.id, name: "Acme", slug: "acme", website: "https://acme.example",
    ownerUserId: "", reportRecipientEmail: "", reportCadence: "monthly", notes: "", archivedAt: null,
    createdAt: agency.createdAt, updatedAt: agency.updatedAt,
  } satisfies Client
  const workflow = {
    id: "workflow-1", agencyId: agency.id, clientId: client.id, name: "Lead form", type: "http_endpoint",
    environment: "production", endpointUrl: "https://acme.example/health", method: "GET", headers: [], requestBody: "",
    expectedStatus: 200, timeoutSeconds: 10, maxLatencyMs: 5000, frequencyMinutes: 1440, retries: 2,
    reportIncluded: true, storeRawResponse: false, status: "pending", healthScore: 0, lastCheckRunAt: null,
    archivedAt: null, createdAt: agency.createdAt, updatedAt: agency.updatedAt,
  } satisfies Workflow

  assert.equal(workspaceFromAgency(agency).id, agency.id)
  assert.equal(projectFromClient(client).kind, "client_site")
  const journey = journeyFromWorkflow(workflow)
  assert.equal(journey.template, "legacy_endpoint")
  assert.equal(journey.projectId, client.id)
  assert.equal(journey.workspaceId, agency.id)
})
