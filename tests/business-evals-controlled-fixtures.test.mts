import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  controlledFixtureScenario,
  controlledFixtureScenarios,
  controlledFixtureTemplate,
  isControlledFixtureEnabled,
} from "../src/lib/evals/controlled-fixtures.ts"

test("controlled fixtures cover every required runner outcome and stay production-gated", () => {
  assert.deepEqual(controlledFixtureScenarios, [
    "healthy-lead",
    "failed-lead",
    "delayed-email",
    "captcha-blocked",
    "missing-email",
    "malicious-link",
    "healthy-trial",
    "cleanup-failure",
  ])
  assert.equal(controlledFixtureScenario("arbitrary"), null)
  assert.equal(controlledFixtureTemplate("healthy-lead"), "lead_form")
  assert.equal(controlledFixtureTemplate("healthy-trial"), "trial_signup")
  assert.equal(isControlledFixtureEnabled({ NODE_ENV: "development" }), true)
  assert.equal(isControlledFixtureEnabled({ NODE_ENV: "production" }), false)
  assert.equal(isControlledFixtureEnabled({ NODE_ENV: "production", BUSINESS_EVALS_FIXTURES_ENABLED: "true" }), true)
})

test("fixture submission cannot email outside the configured inbound domain or omit the synthetic marker", () => {
  const route = readFileSync("src/app/api/business-evals-fixtures/submit/route.ts", "utf8")
  const token = readFileSync("src/lib/evals/controlled-fixture-token.server.ts", "utf8")
  const page = readFileSync("src/components/evals/controlled-fixture-page.tsx", "utf8")

  assert.match(route, /recipientDomain\(input\.email\) !== inboundDomain/)
  assert.match(route, /SYNTHETIC_MARKER_REQUIRED/)
  assert.match(route, /BUSINESS_EVALS_FIXTURE_FROM_EMAIL/)
  assert.match(route, /idempotencyKey: input\.idempotencyKey/)
  assert.match(token, /createHmac\("sha256"/)
  assert.match(token, /15 \* 60 \* 1_000/)
  assert.match(page, /data-sitekey="controlled-fixture"/)
  assert.match(page, />Account deleted</)
  assert.match(page, />Cleanup failed</)
})
