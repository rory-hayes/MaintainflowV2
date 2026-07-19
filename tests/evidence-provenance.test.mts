import assert from "node:assert/strict"
import test from "node:test"

import { currentMonthToDate } from "../src/lib/core/report-period.ts"
import { serviceIssuedAssuranceView } from "../src/lib/core/evidence-provenance.ts"
import { reportSnapshotUsesOnlyServiceEvidence } from "../src/lib/core/report-state.ts"
import {
  activationChecklist,
  createReportDownload,
  createAgencyWorkspace,
  createClientRecord,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  generateReportRecord,
  runWorkflowCheck,
} from "../src/lib/core/local-store.ts"
import type { EndpointTestResult } from "../src/lib/core/types.ts"

const user = {
  id: "provenance-user",
  name: "Provenance Tester",
  email: "provenance@maintainflow.test",
  company: "Provenance Test",
  role: "Owner",
}

const healthyResult: EndpointTestResult = {
  status: "healthy",
  statusCode: 200,
  latencyMs: 42,
  assertionResults: [],
  safeResponseSummary: "The endpoint returned a healthy response.",
  errorMessage: "",
}

function healthyScenario() {
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Provenance Test",
    slug: "provenance-test",
  })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Evidence Client" })
  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: database.clients[0].id,
    name: "Evidence Journey",
    endpointUrl: "https://health.provenance-example.com/status",
    method: "GET",
    headers: {},
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
    frequencyMinutes: 60,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    environment: "production",
    type: "http_endpoint",
    assertions: [],
  }, healthyResult)
  return { agency, database }
}

test("legacy browser runs stay stored but cannot drive customer assurance state", () => {
  const { agency, database } = healthyScenario()
  const withLegacyOnly = {
    ...database,
    checkRuns: database.checkRuns.map((run) => ({ ...run, evidenceOrigin: "legacy_browser" as const })),
  }
  const customerView = serviceIssuedAssuranceView(withLegacyOnly)

  assert.equal(withLegacyOnly.checkRuns.length, 1)
  assert.equal(customerView.checkRuns.length, 0)
  assert.equal(customerView.workflows[0].status, "pending")
  assert.equal(customerView.workflows[0].healthScore, 0)
  assert.equal(customerView.workflows[0].lastCheckRunAt, null)
  assert.equal(customerView.checks[0].lastRunAt, null)
  assert.equal(activationChecklist(customerView, agency.id).firstCheckRun, false)
})

test("legacy browser runs cannot make a report ready or produce client proof", () => {
  const { agency, database } = healthyScenario()
  const period = currentMonthToDate()
  const withLegacyOnly = {
    ...database,
    checkRuns: database.checkRuns.map((run) => ({
      ...run,
      evidenceOrigin: "legacy_browser" as const,
      startedAt: `${period.periodEnd}T09:00:00.000Z`,
      completedAt: `${period.periodEnd}T09:00:00.000Z`,
      createdAt: `${period.periodEnd}T09:00:00.000Z`,
    })),
  }

  assert.throws(
    () => generateReportRecord(withLegacyOnly, agency, user.id, {
      clientId: database.clients[0].id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    }),
    /run at least one report-included workflow check/i,
  )
})

test("report snapshot trust fails closed when run provenance is legacy or missing", () => {
  const { agency, database } = healthyScenario()
  const period = currentMonthToDate()
  const inPeriod = {
    ...database,
    checkRuns: database.checkRuns.map((run) => ({
      ...run,
      startedAt: `${period.periodEnd}T09:00:00.000Z`,
      completedAt: `${period.periodEnd}T09:00:00.000Z`,
      createdAt: `${period.periodEnd}T09:00:00.000Z`,
    })),
  }
  const generated = generateReportRecord(inPeriod, agency, user.id, {
    clientId: database.clients[0].id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
  const snapshot = generated.reports[0].snapshot
  assert.ok(snapshot)
  assert.equal(reportSnapshotUsesOnlyServiceEvidence(snapshot), true)

  const legacySnapshot = {
    ...snapshot,
    checkRuns: snapshot.checkRuns.map((run) => ({
      ...run,
      evidenceOrigin: "legacy_browser",
    })),
  } as unknown as typeof snapshot
  assert.equal(reportSnapshotUsesOnlyServiceEvidence(legacySnapshot), false)

  const missingOriginSnapshot = {
    ...snapshot,
    checkRuns: snapshot.checkRuns.map(({ evidenceOrigin, ...run }) => {
      assert.equal(evidenceOrigin, "service")
      return run
    }),
  } as unknown as typeof snapshot
  assert.equal(reportSnapshotUsesOnlyServiceEvidence(missingOriginSnapshot), false)
})

test("legacy verification evidence cannot resolve a service-issued incident", () => {
  const { database } = healthyScenario()
  const sourceRun = {
    ...database.checkRuns[0],
    status: "failed" as const,
  }
  const repairRecordedAt = new Date(new Date(sourceRun.completedAt).getTime() + 1_000).toISOString()
  const legacyVerification = {
    ...sourceRun,
    id: "legacy-verification-run",
    evidenceOrigin: "legacy_browser" as const,
    status: "healthy" as const,
    startedAt: new Date(new Date(repairRecordedAt).getTime() + 1_000).toISOString(),
    completedAt: new Date(new Date(repairRecordedAt).getTime() + 2_000).toISOString(),
    createdAt: new Date(new Date(repairRecordedAt).getTime() + 2_000).toISOString(),
  }
  const issue = {
    id: "service-incident-with-legacy-verification",
    agencyId: sourceRun.agencyId,
    clientId: sourceRun.clientId,
    workflowId: sourceRun.workflowId,
    checkRunId: sourceRun.id,
    verificationRunId: legacyVerification.id,
    checkId: sourceRun.checkId,
    dedupeKey: "legacy-verification-boundary",
    severity: "high" as const,
    status: "resolved" as const,
    title: "Customer journey failed",
    description: "The customer journey failed.",
    suggestedAction: "Repair and rerun the service check.",
    ownerUserId: user.id,
    reportable: true,
    occurrenceCount: 1,
    snoozedUntil: null,
    repairRecordedAt,
    resolvedAt: legacyVerification.completedAt,
    resolutionNote: "The repair was recorded.",
    reportSafeSummary: "The repair still needs trusted verification.",
    createdAt: sourceRun.createdAt,
    updatedAt: legacyVerification.completedAt,
  }
  const customerView = serviceIssuedAssuranceView({
    ...database,
    checkRuns: [sourceRun, legacyVerification],
    issues: [issue],
  })

  assert.deepEqual(customerView.checkRuns.map((run) => run.id), [sourceRun.id])
  assert.equal(customerView.issues[0].status, "in_review")
  assert.equal(customerView.issues[0].verificationRunId, null)
  assert.equal(customerView.issues[0].resolvedAt, null)
})

test("current workflow health and activation require service coverage for every active check", () => {
  const { agency, database } = healthyScenario()
  const firstCheck = database.checks[0]
  const secondCheck = {
    ...firstCheck,
    id: "second-active-check",
    name: "Second active check",
    lastRunAt: null,
    nextRunAt: null,
  }
  const missingCoverage = serviceIssuedAssuranceView({
    ...database,
    checks: [firstCheck, secondCheck],
  })

  assert.equal(missingCoverage.checkRuns.length, 1, "historical service evidence remains visible")
  assert.equal(missingCoverage.workflows[0].status, "pending")
  assert.equal(missingCoverage.workflows[0].healthScore, 0)
  assert.equal(activationChecklist(missingCoverage, agency.id).firstCheckRun, false)

  const failedSecondRun = {
    ...database.checkRuns[0],
    id: "second-active-check-failure",
    checkId: secondCheck.id,
    status: "failed" as const,
    startedAt: new Date(new Date(database.checkRuns[0].startedAt).getTime() + 1_000).toISOString(),
    completedAt: new Date(new Date(database.checkRuns[0].completedAt).getTime() + 1_000).toISOString(),
    createdAt: new Date(new Date(database.checkRuns[0].createdAt).getTime() + 1_000).toISOString(),
  }
  const failedCoverage = serviceIssuedAssuranceView({
    ...database,
    checks: [firstCheck, secondCheck],
    checkRuns: [failedSecondRun, ...database.checkRuns],
  })

  assert.equal(failedCoverage.workflows[0].status, "failed")
  assert.equal(failedCoverage.workflows[0].healthScore, 24)
  assert.equal(activationChecklist(failedCoverage, agency.id).firstCheckRun, true)

  const skippedAfterFailure = {
    ...failedSecondRun,
    id: "second-active-check-inconclusive",
    status: "skipped" as const,
    startedAt: new Date(new Date(failedSecondRun.startedAt).getTime() + 1_000).toISOString(),
    completedAt: new Date(new Date(failedSecondRun.completedAt).getTime() + 1_000).toISOString(),
    createdAt: new Date(new Date(failedSecondRun.createdAt).getTime() + 1_000).toISOString(),
  }
  const failedDespiteSkippedAttempt = serviceIssuedAssuranceView({
    ...database,
    checks: [firstCheck, secondCheck],
    checkRuns: [skippedAfterFailure, failedSecondRun, ...database.checkRuns],
  })

  assert.equal(failedDespiteSkippedAttempt.workflows[0].status, "failed")
  assert.equal(failedDespiteSkippedAttempt.workflows[0].healthScore, 24)

  let exactCheckRuns = runWorkflowCheck(
    { ...database, checks: [firstCheck, secondCheck] },
    agency.id,
    user.id,
    database.workflows[0].id,
    secondCheck.id,
    { ...healthyResult, status: "failed", statusCode: 503, errorMessage: "Second check failed." }
  )
  assert.equal(exactCheckRuns.checkRuns[0].checkId, secondCheck.id)
  exactCheckRuns = runWorkflowCheck(
    exactCheckRuns,
    agency.id,
    user.id,
    database.workflows[0].id,
    firstCheck.id,
    healthyResult
  )
  assert.equal(exactCheckRuns.checkRuns[0].checkId, firstCheck.id)
  assert.equal(exactCheckRuns.workflows[0].status, "failed", "the healthy sibling cannot hide the failed check")
})

test("disabled green evidence cannot cover an unrun active check", () => {
  const { agency, database } = healthyScenario()
  const disabledGreenCheck = { ...database.checks[0], enabled: false }
  const activeUnrunCheck = {
    ...database.checks[0],
    id: "replacement-active-check",
    name: "Replacement active check",
    lastRunAt: null,
    nextRunAt: null,
  }
  const customerView = serviceIssuedAssuranceView({
    ...database,
    checks: [disabledGreenCheck, activeUnrunCheck],
  })

  assert.equal(customerView.checkRuns.length, 1, "the disabled check's service run remains auditable")
  assert.equal(customerView.workflows[0].status, "pending")
  assert.equal(customerView.workflows[0].healthScore, 0)
  assert.equal(customerView.workflows[0].lastCheckRunAt, null)
  assert.equal(activationChecklist(customerView, agency.id).firstCheckRun, false)
})

test("reports and PDFs require current service evidence for every active check", () => {
  const { agency, database } = healthyScenario()
  const period = currentMonthToDate()
  const firstCheck = database.checks[0]
  const secondCheck = {
    ...firstCheck,
    id: "report-second-check",
    name: "Report second check",
    lastRunAt: null,
    nextRunAt: null,
  }
  const serviceRunInPeriod = {
    ...database.checkRuns[0],
    startedAt: `${period.periodEnd}T09:00:00.000Z`,
    completedAt: `${period.periodEnd}T09:00:01.000Z`,
    createdAt: `${period.periodEnd}T09:00:01.000Z`,
  }
  const missingSecondRun = {
    ...database,
    checks: [firstCheck, secondCheck],
    checkRuns: [serviceRunInPeriod],
  }
  const generatedMissing = generateReportRecord(missingSecondRun, agency, user.id, {
    clientId: database.clients[0].id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
  const missingReport = generatedMissing.reports[0]

  assert.deepEqual(new Set(missingReport.snapshot?.checkIds), new Set([firstCheck.id, secondCheck.id]))
  assert.equal(missingReport.snapshot?.workflowCoverage[0].status, "inconclusive")
  assert.equal(missingReport.readiness.checksAvailable, true)
  assert.equal(missingReport.readiness.activeCheckCoverageComplete, false)
  assert.equal(missingReport.status, "blocked")
  assert.throws(
    () => createReportDownload(generatedMissing, agency, user.id, missingReport.id),
    /passing verification run/i,
  )

  const failedSecondRun = {
    ...serviceRunInPeriod,
    id: "report-second-check-failure",
    checkId: secondCheck.id,
    status: "failed" as const,
    startedAt: `${period.periodEnd}T09:05:00.000Z`,
    completedAt: `${period.periodEnd}T09:05:01.000Z`,
    createdAt: `${period.periodEnd}T09:05:01.000Z`,
  }
  const generatedFailed = generateReportRecord({
    ...missingSecondRun,
    checkRuns: [failedSecondRun, serviceRunInPeriod],
  }, agency, user.id, {
    clientId: database.clients[0].id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
  const failedReport = generatedFailed.reports[0]

  assert.equal(failedReport.readiness.checksAvailable, true)
  assert.equal(failedReport.readiness.activeCheckCoverageComplete, true)
  assert.equal(failedReport.readiness.latestEvidenceAcceptable, false)
  assert.equal(failedReport.snapshot?.workflowCoverage[0].status, "failed")
  assert.equal(failedReport.status, "blocked")
  assert.throws(
    () => createReportDownload(generatedFailed, agency, user.id, failedReport.id),
    /passing verification run/i,
  )
})

test("disabling a check does not hide its unresolved service-backed incident from reports", () => {
  const { agency, database } = healthyScenario()
  const period = currentMonthToDate()
  const disabledCheck = { ...database.checks[0], enabled: false }
  const activeCheck = {
    ...database.checks[0],
    id: "active-replacement-check",
    name: "Active replacement check",
  }
  const disabledFailure = {
    ...database.checkRuns[0],
    status: "failed" as const,
    startedAt: `${period.periodEnd}T08:00:00.000Z`,
    completedAt: `${period.periodEnd}T08:00:01.000Z`,
    createdAt: `${period.periodEnd}T08:00:01.000Z`,
  }
  const activeHealthyRun = {
    ...database.checkRuns[0],
    id: "active-replacement-run",
    checkId: activeCheck.id,
    startedAt: `${period.periodEnd}T09:00:00.000Z`,
    completedAt: `${period.periodEnd}T09:00:01.000Z`,
    createdAt: `${period.periodEnd}T09:00:01.000Z`,
  }
  const unresolvedDisabledIssue = {
    id: "disabled-check-unresolved-issue",
    agencyId: disabledFailure.agencyId,
    clientId: disabledFailure.clientId,
    workflowId: disabledFailure.workflowId,
    checkRunId: disabledFailure.id,
    verificationRunId: null,
    checkId: disabledFailure.checkId,
    dedupeKey: "disabled-check-unresolved",
    severity: "high" as const,
    status: "open" as const,
    title: "Historical customer failure remains unresolved",
    description: "The disabled check detected a customer-facing failure.",
    suggestedAction: "Review and resolve the historical failure.",
    ownerUserId: user.id,
    reportable: true,
    occurrenceCount: 1,
    snoozedUntil: null,
    repairRecordedAt: null,
    resolvedAt: null,
    resolutionNote: "",
    reportSafeSummary: "",
    createdAt: disabledFailure.createdAt,
    updatedAt: disabledFailure.createdAt,
  }
  const generated = generateReportRecord({
    ...database,
    checks: [disabledCheck, activeCheck],
    checkRuns: [activeHealthyRun, disabledFailure],
    issues: [unresolvedDisabledIssue],
  }, agency, user.id, {
    clientId: database.clients[0].id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
  const report = generated.reports[0]

  assert.deepEqual(report.snapshot?.checkIds, [activeCheck.id])
  assert.equal(report.snapshot?.checkRuns.length, 2, "historical service evidence remains in the snapshot")
  assert.equal(report.snapshot?.metrics.checksRun, 2)
  assert.equal(report.snapshot?.metrics.passRate, 50)
  assert.equal(report.snapshot?.issues[0].issueId, unresolvedDisabledIssue.id)
  assert.equal(report.snapshot?.workflowCoverage[0].status, "healthy")
  assert.equal(report.readiness.issuesReviewed, false)
  assert.equal(report.status, "blocked")
})
