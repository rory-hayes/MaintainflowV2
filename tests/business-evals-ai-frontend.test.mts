import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const aiReview = readFileSync("src/components/evals/ai-draft-review.tsx", "utf8")
const builder = readFileSync("src/components/evals/pages/journeys-pages.tsx", "utf8")
const runDetail = readFileSync("src/components/evals/pages/eval-runs-pages.tsx", "utf8")

test("AI journey suggestions remain reviewable unpublished drafts", () => {
  assert.match(aiReview, />Draft</)
  assert.match(aiReview, /Apply to draft/)
  assert.match(aiReview, /applying a suggestion changes only this unpublished form state/i)
  assert.match(aiReview, /cannot publish a version, change a verdict, or enable a schedule/i)
  assert.match(builder, /Save and publish version/)
  assert.match(builder, /setAppliedAiSuggestionIds/)
  assert.match(builder, /safeSyntheticValueKeys\.includes/)
  assert.match(builder, /locator\.kind !== "role" \|\| locator\.role !== "button"/)
})

test("AI journey drafting uses the tenant-scoped typed client and fails without changing deterministic controls", () => {
  assert.match(builder, /businessEvalsRequest\(/)
  assert.match(builder, /"\/api\/business-evals\/ai\/journey-draft"/)
  assert.match(builder, /aiJourneyDraftResponseSchema/)
  assert.match(builder, /idempotencyKey: createIdempotencyKey\("ai-journey-draft"\)/)
  assert.match(aiReview, /Your deterministic configuration is unchanged and remains fully editable/)
  assert.match(aiReview, /You can continue configuring this journey without AI/)
})

test("failed and inconclusive run diagnosis is non-mutating and preserves deterministic evidence", () => {
  assert.match(runDetail, /run\.status === "failed" \|\| run\.status === "inconclusive"/)
  assert.match(runDetail, /"\/api\/business-evals\/ai\/run-diagnosis"/)
  assert.match(runDetail, /idempotencyKey: createIdempotencyKey\("ai-run-diagnosis"\)/)
  assert.match(aiReview, /immutable \{status\} verdict and its source evidence cannot be changed by AI/)
  assert.match(aiReview, /AI cannot mark the incident resolved or turn this run green/)
  assert.doesNotMatch(aiReview, /mutateIncident|runJourney|configureJourneySchedule/)
})
