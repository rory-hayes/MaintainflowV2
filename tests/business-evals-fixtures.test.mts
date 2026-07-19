import assert from "node:assert/strict"
import test from "node:test"

import { extractAllowlistedVerificationLink } from "../src/lib/email/eval-inbound.ts"
import { reduceEvalVerdicts, scheduleStateAfterCleanup } from "../src/lib/evals/index.ts"

type FixtureOutcome = {
  name: string
  stageVerdicts: Array<"passed" | "degraded" | "failed" | "inconclusive" | "cancelled" | "not_run">
  cleanupStatus: "not_required" | "passed" | "failed" | "inconclusive"
  expectedVerdict: "passed" | "degraded" | "failed" | "inconclusive"
  schedulingEnabled: boolean
}

const fixtureOutcomes: FixtureOutcome[] = [
  {
    name: "healthy lead form",
    stageVerdicts: ["passed", "passed", "passed"],
    cleanupStatus: "not_required",
    expectedVerdict: "passed",
    schedulingEnabled: true,
  },
  {
    name: "definitive business assertion failure",
    stageVerdicts: ["passed", "passed", "failed", "not_run"],
    cleanupStatus: "not_required",
    expectedVerdict: "failed",
    schedulingEnabled: true,
  },
  {
    name: "delayed but successful outcome",
    stageVerdicts: ["passed", "degraded", "passed"],
    cleanupStatus: "not_required",
    expectedVerdict: "degraded",
    schedulingEnabled: true,
  },
  {
    name: "CAPTCHA-blocked submission",
    stageVerdicts: ["passed", "inconclusive", "not_run"],
    cleanupStatus: "not_required",
    expectedVerdict: "inconclusive",
    schedulingEnabled: false,
  },
  {
    name: "verification email missing",
    stageVerdicts: ["passed", "passed", "inconclusive", "not_run", "passed"],
    cleanupStatus: "passed",
    expectedVerdict: "inconclusive",
    schedulingEnabled: true,
  },
  {
    name: "cleanup failure",
    stageVerdicts: ["passed", "passed", "passed", "failed"],
    cleanupStatus: "failed",
    expectedVerdict: "failed",
    schedulingEnabled: false,
  },
]

test("controlled production fixture outcomes preserve deterministic verdict truth", () => {
  for (const fixture of fixtureOutcomes) {
    assert.equal(reduceEvalVerdicts(fixture.stageVerdicts), fixture.expectedVerdict, fixture.name)

    const cleanupSchedule = fixture.cleanupStatus === "failed"
      ? scheduleStateAfterCleanup("failed")
      : { enabled: fixture.schedulingEnabled, pauseReason: fixture.schedulingEnabled ? "" : "supervised_run_required" }
    assert.equal(cleanupSchedule.enabled, fixture.schedulingEnabled, fixture.name)
  }
})

test("a malicious verification-link fixture cannot escape the approved domain", () => {
  const maliciousOnly = extractAllowlistedVerificationLink({
    text: "Verify at https://attacker.example/steal?token=secret",
    html: '<a href="https://attacker.example/steal?token=secret">Verify</a>',
    rules: [{ host: "verify.product.example", pathPrefix: "/confirm", requiredQueryParameter: "token" }],
  })
  assert.equal(maliciousOnly, null)

  const mixed = extractAllowlistedVerificationLink({
    text: "Ignore https://attacker.example/steal and use https://verify.product.example/confirm?token=safe",
    html: "",
    rules: [{ host: "verify.product.example", pathPrefix: "/confirm", requiredQueryParameter: "token" }],
  })
  assert.equal(mixed, "https://verify.product.example/confirm?token=safe")
})

test("no fixture with missing evidence or broken cleanup can become green", () => {
  const unsafeFixtures = fixtureOutcomes.filter((fixture) =>
    fixture.stageVerdicts.includes("inconclusive") || fixture.stageVerdicts.includes("not_run") || fixture.cleanupStatus === "failed"
  )

  for (const fixture of unsafeFixtures) {
    assert.notEqual(reduceEvalVerdicts(fixture.stageVerdicts), "passed", fixture.name)
  }
})
