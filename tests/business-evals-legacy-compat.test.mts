import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isLegacyEndpointIncident,
  legacyEndpointVerdict,
  legacyReportMetrics,
  mergeLegacyEndpointHistory,
  presentLegacyEndpointRun,
} from "../src/lib/evals/legacy-endpoint-compat.ts"

test("legacy endpoint statuses map to business-eval verdicts without inventing stage evidence", () => {
  assert.equal(legacyEndpointVerdict("healthy"), "passed")
  assert.equal(legacyEndpointVerdict("degraded"), "degraded")
  assert.equal(legacyEndpointVerdict("failed"), "failed")
  assert.equal(legacyEndpointVerdict("skipped"), "inconclusive")

  const run = presentLegacyEndpointRun({
    id: "run-1",
    client_id: "project-1",
    workflow_id: "journey-1",
    check_id: "check-1",
    evidence_origin: "service",
    status: "healthy",
    status_code: 204,
    latency_ms: 87,
    assertion_results_json: [{ id: "status", passed: true }],
    safe_response_summary: "Expected status received.",
    error_message: "",
    started_at: "2026-07-18T10:00:00.000Z",
    completed_at: "2026-07-18T10:00:00.087Z",
    created_at: "2026-07-18T10:00:00.087Z",
  }, "Homepage health")

  assert.equal(run.source, "legacy_endpoint")
  assert.equal(run.runnerProvider, "deterministic_endpoint_monitor")
  assert.equal(run.verdict, "passed")
  assert.equal(run.stageEvidenceAvailable, false)
  assert.deepEqual(run.stages, [])
  assert.deepEqual(run.evidence, [])
  assert.deepEqual(run.legacyEndpointEvidence, {
    checkId: "check-1",
    checkName: "Homepage health",
    evidenceOrigin: "service",
    statusCode: 204,
    latencyMs: 87,
    assertionResults: [{ id: "status", passed: true }],
    safeResponseSummary: "Expected status received.",
    errorMessage: "",
  })
})

test("legacy and business-eval history share one chronological, paginated ledger", () => {
  const firstPage = mergeLegacyEndpointHistory(
    [
      { id: "eval-new", createdAt: "2026-07-18T12:00:00Z" },
      { id: "eval-old", createdAt: "2026-07-18T09:00:00Z" },
    ],
    [
      { id: "legacy-middle", createdAt: "2026-07-18T11:00:00Z" },
      { id: "legacy-oldest", createdAt: "2026-07-18T08:00:00Z" },
    ],
    0,
    3,
  )
  assert.deepEqual(firstPage.rows.map((row) => row.id), ["eval-new", "legacy-middle", "eval-old"])
  assert.equal(firstPage.hasMore, true)

  const secondPage = mergeLegacyEndpointHistory(
    [{ id: "eval-new", createdAt: "2026-07-18T12:00:00Z" }, { id: "eval-old", createdAt: "2026-07-18T09:00:00Z" }],
    [{ id: "legacy-middle", createdAt: "2026-07-18T11:00:00Z" }, { id: "legacy-oldest", createdAt: "2026-07-18T08:00:00Z" }],
    3,
    3,
  )
  assert.deepEqual(secondPage.rows.map((row) => row.id), ["legacy-oldest"])
  assert.equal(secondPage.hasMore, false)
})

test("incident provenance distinguishes physical legacy issue history", () => {
  assert.equal(isLegacyEndpointIncident({ check_run_id: "legacy-run", eval_run_id: null }), true)
  assert.equal(isLegacyEndpointIncident({ check_run_id: null, eval_run_id: null }), true)
  assert.equal(isLegacyEndpointIncident({ eval_run_id: "eval-run" }), false)
  assert.equal(isLegacyEndpointIncident({ verification_eval_run_id: "eval-run" }), false)
})

test("existing reports retain legacy endpoint counts and provenance", () => {
  const legacy = legacyReportMetrics({
    eval_snapshot_idempotency_key: null,
    snapshot_json: {
      metrics: {
        workflowsMonitored: 4,
        checksRun: 18,
        passRate: 94.4,
        issuesResolved: 2,
      },
      workflowCoverage: [{}, {}, {}, {}],
    },
  })
  assert.equal(legacy.source, "legacy_endpoint")
  assert.equal(legacy.journeysCovered, 4)
  assert.equal(legacy.checksRun, 18)
  assert.equal(legacy.passRate, 94.4)
  assert.equal(legacy.incidentsResolved, 2)

  const evalReport = legacyReportMetrics({
    eval_snapshot_idempotency_key: "report-key",
    snapshot_json: { metrics: { journeysCovered: 2, evalRuns: 8, passedRuns: 6, passRate: 75, incidentsResolved: 1 } },
  })
  assert.equal(evalReport.source, "business_eval")
  assert.equal(evalReport.journeysCovered, 2)
})

test("legacy compatibility stays additive, tenant-scoped, and out of eval stage tables", () => {
  const evalRuns = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
  const incidents = readFileSync("src/lib/api/incidents.server.ts", "utf8")
  const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  const projects = readFileSync("src/lib/api/projects.server.ts", "utf8")
  const reports = readFileSync("src/lib/api/reports.server.ts", "utf8")

  assert.match(evalRuns, /check_runs\?\$\{query\(legacyFilters\)\}/)
  assert.match(evalRuns, /agency_id: `eq\.\$\{input\.agencyId\}`/)
  assert.match(evalRuns, /agency_id: `eq\.\$\{agencyId\}`/)
  assert.match(incidents, /check_run_id,check_id,verification_run_id,eval_run_id/)
  assert.doesNotMatch(incidents, /eval_run_id: "not\.is\.null"/)
  assert.match(journeys, /source: legacyEndpoint \? "legacy_endpoint" : "business_eval"/)
  assert.match(projects, /legacyEndpointJourneys/)
  assert.match(reports, /shareEligible: compatibility\.source === "business_eval"/)

  for (const source of [evalRuns, incidents, journeys, projects, reports]) {
    assert.doesNotMatch(source, /insert[\s\S]*check_runs/i)
    assert.doesNotMatch(source, /delete[\s\S]*check_runs/i)
  }
})
