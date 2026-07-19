import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { evalsSeedData } from "../src/components/evals/seed-data.ts"

const provider = readFileSync("src/components/evals/evals-provider.tsx", "utf8")
const settings = readFileSync("src/components/evals/pages/settings-pages.tsx", "utf8")
const incidentsPage = readFileSync("src/components/evals/pages/incidents-pages.tsx", "utf8")
const appShell = readFileSync("src/components/evals/evals-app-shell.tsx", "utf8")
const authCard = readFileSync("src/components/auth/auth-card.tsx", "utf8")
const localAuthStorage = readFileSync("src/lib/auth-storage.ts", "utf8")
const legacyPreviewData = readFileSync("src/data/maintainflow.ts", "utf8")

test("the trial preview tells one deterministic degraded-outcome story", () => {
  const journey = evalsSeedData.journeys.find((item) => item.id === "trial-signup")
  const run = evalsSeedData.runs.find((item) => item.id === "run-1014")
  const incident = evalsSeedData.incidents.find((item) => item.id === "inc-verification-delay")
  const report = evalsSeedData.reports.find((item) => item.id === "report-july")

  assert.ok(journey)
  assert.equal(journey.status, "degraded")
  assert.equal(journey.stages.length, 6)
  assert.equal(journey.stages.find((stage) => stage.id === "verification-email")?.status, "degraded")
  assert.equal(journey.stages.find((stage) => stage.id === "link-opened")?.status, "passed")
  assert.equal(journey.stages.find((stage) => stage.id === "workspace-created")?.status, "passed")
  assert.equal(journey.stages.at(-1)?.id, "cleanup-test-account")
  assert.equal(journey.stages.at(-1)?.status, "passed")
  assert.doesNotMatch(journey.stages.map((stage) => stage.observed).join(" "), /average|32%/i)

  assert.ok(run)
  assert.equal(run.status, "degraded")
  assert.equal(run.cleanupStatus, "passed")
  assert.equal(run.stageEvidence?.length, journey.stages.length)
  assert.ok(run.journeyVersionId)
  assert.ok(run.runnerProvider)
  assert.ok(run.completedAt)
  assert.equal(run.stageEvidence?.at(-1)?.definitionId, "cleanup-test-account")
  assert.equal(run.stageEvidence?.at(-1)?.verdict, "passed")

  assert.ok(incident)
  assert.doesNotMatch(`${incident.summary} ${incident.impact}`, /average|32%|activation is blocked/i)
  assert.equal(report?.journeyCoverage?.[0]?.latestVerdict, "degraded")
  assert.equal(report?.evidenceSummaries?.[0]?.verdict, "degraded")
  assert.equal(report?.evidenceSummaries?.[0]?.cleanupStatus, "passed")
})

test("the healthy Lead preview stays browser-only unless email proof is configured", () => {
  const journey = evalsSeedData.journeys.find((item) => item.id === "lead-form")

  assert.ok(journey)
  assert.equal(journey.status, "passed")
  assert.equal(journey.rawDraft?.emailProofConfigured, undefined)
  assert.deepEqual(journey.stages.map((stage) => stage.id), ["lead-page", "form-submit", "success-state"])
  assert.equal(journey.stages.every((stage) => stage.status === "passed"), true)
})

test("visual preview fixtures use explicit synthetic identities and reserved domains", () => {
  const previewData = JSON.stringify(evalsSeedData)
  assert.match(previewData, /Mina Park/)
  assert.match(previewData, /beacon\.example/)
  assert.match(settings, /lena@beacon\.example/)
  assert.match(authCard, /Alex Morgan/)
  assert.match(localAuthStorage, /Demo Owner/)
  assert.match(legacyPreviewData, /owner: "Mina"/)
  assert.doesNotMatch(`${previewData}\n${settings}`, /beaconcrm\.com/i)
})

test("preview mode marks only the current primary navigation item active", () => {
  assert.doesNotMatch(appShell, /preview && item\.prefix === "\/journeys"/)
  assert.match(appShell, /pathname === "\/evals-preview" && item\.prefix === "\/journeys"/)
})

test("project and account menu labels are rendered inside Base UI menu groups", () => {
  assert.match(appShell, /DropdownMenuGroup/)
  assert.doesNotMatch(appShell, /<DropdownMenuContent[^>]*>\s*<DropdownMenuLabel>/)
})

test("preview runs record immutable evidence and linked passing verification resolves incidents", () => {
  assert.match(provider, /journeyVersionId: versionId/)
  assert.match(provider, /runnerProvider: "local_playwright_fixture"/)
  assert.match(provider, /completedAt: "Just now"/)
  assert.match(provider, /stageEvidence: completedStages/)
  assert.match(provider, /verificationEvalRunId: verificationRun\.id/)
  assert.match(provider, /status: "resolved"/)
  assert.match(incidentsPage, /result\.status === "passed"/)
  assert.match(incidentsPage, /passed and is linked as the evidence that resolved this incident/)

  const observationReducer = provider.match(/function previewPassingObservation[\s\S]*?\n}/)?.[0] ?? ""
  assert.ok(observationReducer.indexOf("cleanup|delete|remove") < observationReducer.indexOf("verification[_ -]?opened"))
  assert.ok(observationReducer.indexOf("verification[_ -]?opened") < observationReducer.indexOf("verification[_ -]?received"))
  assert.doesNotMatch(observationReducer, /return current/)
})

test("every settings route has a stable, non-loading preview fixture", () => {
  assert.match(settings, /const previewSettingsWorkspaceId = "00000000-0000-4000-8000-000000000999"/)
  assert.match(settings, /enabled: !previewMode && Boolean\(workspaceId\)/)
  assert.match(settings, /loading: previewMode \? false : query\.isPending/)
  assert.match(settings, /error: previewMode \? ""/)
  for (const path of ["workspace", "team", "alerts", "billing"]) {
    assert.match(settings, new RegExp(`path === "\\/api\\/settings\\/${path}"`))
  }
  assert.match(settings, /Preview only: workspace changes are not persisted\./)
  assert.match(settings, /Preview only: invitations are not sent\./)
  assert.match(settings, /Preview only: alert destinations are not persisted\./)
  assert.match(settings, /Preview only: .* checkout will open after Stripe is connected\./)
})
