import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { currentMonthToDate } from "../src/lib/core/report-period.ts"
import { reportSnapshotIsCurrent } from "../src/lib/core/report-state.ts"
import { reportBundleSnapshotIsCurrent } from "../src/lib/supabase/report-bundle.server.ts"
import { createReportPdfStoragePath } from "../src/lib/supabase/report-storage-path.ts"
import {
  createAgencyWorkspace,
  createClientRecord,
  createReportDownload,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  generateReportRecord,
  recordScheduledCheckJob,
  refreshReportRecord,
  recordIssueRepair,
  runWorkflowCheck,
  updateReportNarrative,
  updateIssueRecord,
} from "../src/lib/core/local-store.ts"
import type { Agency, CoreDatabase, EndpointTestResult } from "../src/lib/core/types.ts"

const user = {
  id: "report_state_user",
  name: "Report State Tester",
  email: "report-state@maintainflow.test",
  company: "Snapshot Test Agency",
  role: "Agency Founder",
}

const failedResult: EndpointTestResult = {
  status: "failed",
  statusCode: 500,
  latencyMs: 920,
  assertionResults: [],
  safeResponseSummary: "The monitored endpoint returned an unexpected status.",
  errorMessage: "Expected 200 but received 500.",
}

const healthyResult: EndpointTestResult = {
  status: "healthy",
  statusCode: 200,
  latencyMs: 145,
  assertionResults: [],
  safeResponseSummary: "The monitored endpoint returned the expected healthy response.",
  errorMessage: "",
}

type Scenario = {
  database: CoreDatabase
  agency: Agency
  clientId: string
  workflowId: string
  checkId: string
  issueId: string
}

function failedScenario(): Scenario {
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Snapshot Test Agency",
    slug: "snapshot-test-agency",
  })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme Evidence Systems" })
  const clientId = database.clients[0].id
  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId,
    name: "Invoice intake monitor",
    endpointUrl: "https://status.example.com/invoice-intake",
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
  }, failedResult)
  database = timestampNewestRun(database, "09:00:00.000Z")

  return {
    database,
    agency,
    clientId,
    workflowId: database.workflows[0].id,
    checkId: database.checks[0].id,
    issueId: database.issues[0].id,
  }
}

function generateReport(scenario: Scenario) {
  const period = currentMonthToDate()
  return generateReportRecord(scenario.database, scenario.agency, user.id, {
    clientId: scenario.clientId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
}

function repairThenVerifyHealthy(scenario: Scenario) {
  const date = currentMonthToDate().periodEnd
  let database = recordIssueRepair(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.issueId,
    "The incident was repaired and is ready for a healthy verification run."
  )
  database = {
    ...database,
    issues: database.issues.map((issue) =>
      issue.id === scenario.issueId ? { ...issue, repairRecordedAt: `${date}T09:30:00.000Z` } : issue
    ),
  }
  database = runWorkflowCheck(
    database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    healthyResult,
    "manual_run",
    `${date}T10:00:00.000Z`
  )
  return timestampNewestRun(database, "10:00:00.000Z")
}

function timestampNewestRun(database: CoreDatabase, time: string) {
  const date = currentMonthToDate().periodEnd
  const createdAt = `${date}T${time}`
  const newestRun = database.checkRuns[0]

  return {
    ...database,
    checkRuns: database.checkRuns.map((run) =>
      run.id === newestRun.id
        ? { ...run, startedAt: createdAt, completedAt: createdAt, createdAt }
        : run
    ),
    workflows: database.workflows.map((workflow) =>
      workflow.id === newestRun.workflowId
        ? { ...workflow, lastCheckRunAt: createdAt, updatedAt: createdAt }
        : workflow
    ),
    checks: database.checks.map((check) =>
      check.id === newestRun.checkId ? { ...check, lastRunAt: createdAt, updatedAt: createdAt } : check
    ),
    issues: database.issues.map((issue) =>
      issue.verificationRunId === newestRun.id
        ? { ...issue, resolvedAt: createdAt, updatedAt: createdAt }
        : issue.checkRunId === newestRun.id
          ? { ...issue, updatedAt: createdAt }
          : issue
    ),
  }
}

function decodePdfDataUrl(value: string | null) {
  assert.ok(value)
  return Buffer.from(value.split(",")[1], "base64").toString("latin1")
}

test("a failed latest run blocks readiness and produces a recovery-first recommendation", () => {
  const scenario = failedScenario()
  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.status, "blocked")
  assert.equal(report.readiness.latestEvidenceAcceptable, false)
  assert.equal(report.readiness.issuesReviewed, false)
  assert.equal(report.snapshot?.workflowCoverage[0].status, "failed")
  assert.equal(report.snapshot?.metrics.passRate, 0)
  assert.match(report.snapshot?.recommendations.join(" ") ?? "", /restore invoice intake monitor/i)
  assert.doesNotMatch(report.snapshot?.recommendations.join(" ") ?? "", /^maintain the current monitoring cadence/i)
})

test("recording a repair without a newer healthy verification run still needs review", () => {
  const scenario = failedScenario()
  scenario.database = recordIssueRepair(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.issueId,
    "Credentials were rotated, but no verification run has completed yet."
  )
  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.status, "blocked")
  assert.equal(report.readiness.latestEvidenceAcceptable, false)
  assert.equal(report.readiness.recoveryVerified, false)
  assert.equal(report.snapshot?.issues[0].status, "in_review")
  assert.equal(report.snapshot?.issues[0].recoveryVerified, false)
  assert.match(report.snapshot?.recommendations.join(" ") ?? "", /healthy verification run before sharing/i)
})

test("a healthy verification after a recorded repair allows the report to become ready", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.status, "ready")
  assert.equal(report.readiness.latestEvidenceAcceptable, true)
  assert.equal(report.readiness.recoveryVerified, true)
  assert.equal(report.snapshot?.issues[0].recoveryVerified, true)
  assert.equal(report.snapshot?.workflowCoverage[0].status, "healthy")
  assert.match(report.narrative, /verified recovery/i)
})

test("editing a prepared PDF creates a canonical presentation revision with a distinct storage path", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  let database = generateReport(scenario)
  const reportId = database.reports[0].id
  const originalVersion = database.reports[0].snapshotVersion
  const originalGeneratedAt = database.reports[0].snapshot!.generatedAt
  const originalFingerprint = database.reports[0].evidenceFingerprint
  const originalCheckRunIds = database.reports[0].snapshot!.checkRunIds
  const originalPath = createReportPdfStoragePath(scenario.agency.id, reportId, originalVersion)

  database = createReportDownload(database, scenario.agency, user.id, reportId)
  database = {
    ...database,
    reports: database.reports.map((report) => report.id === reportId
      ? { ...report, pdfStoragePath: originalPath }
      : report),
  }

  const narrative = "This client-safe revision explains the monitored workflow, completed checks, verified recovery, current readiness, and recommended maintenance actions for this reporting period."
  database = updateReportNarrative(database, scenario.agency, user.id, reportId, narrative)
  const revised = database.reports.find((report) => report.id === reportId)!
  const revisedItems = database.reportItems.filter((item) => item.reportId === reportId)
  const revisedPath = createReportPdfStoragePath(scenario.agency.id, reportId, revised.snapshotVersion)

  assert.equal(revised.snapshotVersion, originalVersion + 1)
  assert.equal(revised.snapshot?.version, originalVersion + 1)
  assert.ok(new Date(revised.snapshot!.generatedAt).getTime() > new Date(originalGeneratedAt).getTime())
  assert.equal(revised.snapshot?.narrative, narrative)
  assert.equal(revised.evidenceFingerprint, originalFingerprint)
  assert.deepEqual(revised.snapshot?.checkRunIds, originalCheckRunIds)
  assert.equal(revised.readiness.pdfGenerated, false)
  assert.equal(revised.pdfDataUrl, null)
  assert.equal(revised.pdfStoragePath, null)
  assert.equal(revised.pdfSnapshotVersion, null)
  assert.equal(revisedItems.length, revised.snapshot?.evidenceItems.length)
  assert.equal(revisedItems.every((item) => item.snapshotVersion === revised.snapshotVersion), true)
  assert.notEqual(revisedPath, originalPath)
  assert.match(revisedPath, /snapshot-2\.pdf$/)
  assert.equal(reportSnapshotIsCurrent(revised, database), true)
  assert.equal(reportBundleSnapshotIsCurrent({
    agency: scenario.agency,
    client: database.clients.find((client) => client.id === scenario.clientId)!,
    report: revised,
    workflows: database.workflows,
    checks: database.checks,
    checkRuns: database.checkRuns,
    issues: database.issues,
    issueNotes: database.issueNotes,
    reportItems: revisedItems,
  }), true)
})

test("narrative edits cannot bless stale evidence as a new report revision", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const database = generateReport(scenario)
  const reportId = database.reports[0].id
  const changedEvidence = {
    ...database,
    workflows: database.workflows.map((workflow) => workflow.id === scenario.workflowId
      ? { ...workflow, name: "Changed after snapshot" }
      : workflow),
  }

  assert.throws(
    () => updateReportNarrative(
      changedEvidence,
      scenario.agency,
      user.id,
      reportId,
      "This otherwise valid client narrative must not convert stale evidence into a current report revision."
    ),
    /report is stale.*refresh from latest evidence/i
  )
})

test("later healthy evidence preserves the original verified repair", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const verificationRunId = scenario.database.issues[0].verificationRunId

  scenario.database = runWorkflowCheck(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    healthyResult,
    "manual_run",
    `${currentMonthToDate().periodEnd}T11:00:00.000Z`
  )
  scenario.database = timestampNewestRun(scenario.database, "11:00:00.000Z")
  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(database.issues[0].status, "resolved")
  assert.equal(database.issues[0].verificationRunId, verificationRunId)
  assert.notEqual(database.checkRuns[0].id, verificationRunId)
  assert.equal(report.status, "ready")
  assert.equal(report.snapshot?.issues[0].recoveryVerified, true)
})

test("a resolved issue without client-safe recovery text cannot become report-ready", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  scenario.database = {
    ...scenario.database,
    issues: scenario.database.issues.map((issue) => ({ ...issue, reportSafeSummary: "" })),
  }

  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.snapshot?.issues[0].status, "resolved")
  assert.equal(report.snapshot?.issues[0].reportSafeSummary, "")
  assert.equal(report.snapshot?.issues[0].recoveryVerified, false)
  assert.equal(report.readiness.recoveryVerified, false)
  assert.equal(report.status, "blocked")
  assert.throws(
    () => createReportDownload(database, scenario.agency, user.id, report.id),
    /passing verification run/i,
  )
})

test("new failed evidence reopens the same issue and invalidates a prepared report PDF", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  let database = generateReport(scenario)
  const reportId = database.reports[0].id
  const issueId = database.issues[0].id
  const snapshotVersion = database.reports[0].snapshotVersion

  database = createReportDownload(database, scenario.agency, user.id, reportId)
  assert.equal(database.reports[0].pdfSnapshotVersion, snapshotVersion)
  assert.match(database.reports[0].pdfDataUrl ?? "", /^data:application\/pdf;base64,/)

  database = runWorkflowCheck(
    database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    failedResult,
    "manual_run",
    `${currentMonthToDate().periodEnd}T11:00:00.000Z`
  )
  database = timestampNewestRun(database, "11:00:00.000Z")

  const report = database.reports.find((item) => item.id === reportId)!
  const issue = database.issues[0]
  assert.equal(database.issues.length, 1)
  assert.equal(issue.id, issueId)
  assert.equal(issue.status, "open")
  assert.equal(issue.occurrenceCount, 2)
  assert.equal(issue.checkRunId, database.checkRuns[0].id)
  assert.equal(report.status, "blocked")
  assert.ok(report.staleAt)
  assert.equal(report.snapshotVersion, snapshotVersion)
  assert.equal(report.readiness.snapshotCurrent, false)
  assert.equal(report.readiness.pdfGenerated, false)
  assert.equal(report.pdfDataUrl, null)
  assert.equal(report.pdfStoragePath, null)
  assert.equal(report.pdfSnapshotVersion, null)
  assert.throws(
    () => createReportDownload(database, scenario.agency, user.id, reportId),
    /report is stale.*refresh from latest evidence/i
  )
})

test("a different newer failure invalidates every resolved and repair-pending issue for the check", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const resolvedIssue = scenario.database.issues.find((issue) => issue.id === scenario.issueId)!
  const pendingIssueId = "pending_issue_for_same_check"
  scenario.database = {
    ...scenario.database,
    issues: [
      {
        ...resolvedIssue,
        id: pendingIssueId,
        dedupeKey: `${scenario.checkId}:A second repaired failure`,
        status: "in_review",
        repairRecordedAt: `${currentMonthToDate().periodEnd}T10:30:00.000Z`,
        resolvedAt: null,
        verificationRunId: null,
        resolutionNote: "A second repair is waiting for verification.",
        reportSafeSummary: "A second repair is waiting for verification.",
      },
      ...scenario.database.issues,
    ],
  }
  const differentFailure: EndpointTestResult = {
    ...failedResult,
    statusCode: 503,
    errorMessage: "Expected 200 but received 503.",
  }

  scenario.database = runWorkflowCheck(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    differentFailure,
    "manual_run",
    `${currentMonthToDate().periodEnd}T11:00:00.000Z`
  )

  const priorIssue = scenario.database.issues.find((issue) => issue.id === scenario.issueId)
  const pendingIssue = scenario.database.issues.find((issue) => issue.id === pendingIssueId)
  const currentIssue = scenario.database.issues.find((issue) => issue.checkRunId === scenario.database.checkRuns[0].id)
  assert.equal(scenario.database.issues.length, 3)
  assert.equal(priorIssue?.status, "open")
  assert.equal(priorIssue?.occurrenceCount, 1)
  assert.equal(priorIssue?.repairRecordedAt, null)
  assert.equal(priorIssue?.verificationRunId, null)
  assert.equal(pendingIssue?.status, "open")
  assert.equal(pendingIssue?.repairRecordedAt, null)
  assert.equal(pendingIssue?.resolutionNote, "")
  assert.equal(currentIssue?.status, "open")
  assert.match(currentIssue?.dedupeKey ?? "", /503/)
})

test("a failure that started before the repair does not invalidate its verified issue", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const occurrenceCount = scenario.database.issues[0].occurrenceCount

  scenario.database = runWorkflowCheck(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    failedResult,
    "scheduled_run",
    `${currentMonthToDate().periodEnd}T09:15:00.000Z`
  )

  assert.equal(scenario.database.issues.length, 1)
  assert.equal(scenario.database.issues[0].status, "resolved")
  assert.equal(scenario.database.issues[0].occurrenceCount, occurrenceCount)
  assert.ok(scenario.database.issues[0].verificationRunId)
})

test("refresh creates one internally consistent report version and PDF from the latest evidence", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  let database = generateReport(scenario)
  const reportId = database.reports[0].id

  database = createReportDownload(database, scenario.agency, user.id, reportId)
  database = runWorkflowCheck(
    database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    failedResult,
    "manual_run",
    `${currentMonthToDate().periodEnd}T11:00:00.000Z`
  )
  database = timestampNewestRun(database, "11:00:00.000Z")
  database = recordIssueRepair(
    database,
    scenario.agency.id,
    user.id,
    scenario.issueId,
    "The repeated incident was repaired and is ready for a new verification run."
  )
  const date = currentMonthToDate().periodEnd
  database = {
    ...database,
    issues: database.issues.map((issue) =>
      issue.id === scenario.issueId ? { ...issue, repairRecordedAt: `${date}T11:30:00.000Z` } : issue
    ),
  }
  database = runWorkflowCheck(
    database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    healthyResult,
    "manual_run",
    `${date}T12:00:00.000Z`
  )
  database = timestampNewestRun(database, "12:00:00.000Z")

  const staleVersion = database.reports[0].snapshotVersion
  assert.equal(database.reports[0].status, "blocked")
  database = refreshReportRecord(database, scenario.agency, user.id, reportId)

  let report = database.reports[0]
  const snapshot = report.snapshot!
  const versionItems = database.reportItems.filter(
    (item) => item.reportId === reportId && item.snapshotVersion === report.snapshotVersion
  )
  assert.equal(report.snapshotVersion, staleVersion + 1)
  assert.equal(snapshot.version, report.snapshotVersion)
  assert.equal(report.status, "ready")
  assert.equal(report.staleAt, null)
  assert.deepEqual(report.metrics, snapshot.metrics)
  assert.equal(report.narrative, snapshot.narrative)
  assert.equal(snapshot.metrics.checksRun, 4)
  assert.equal(snapshot.metrics.passRate, 50)
  assert.equal(snapshot.checkRunIds.length, 4)
  assert.equal(snapshot.checkRuns.length, 4)
  assert.equal(snapshot.issues[0].recoveryVerified, true)
  assert.match(snapshot.narrative, /recorded 4 check runs/i)
  assert.match(snapshot.narrative, /pass rate was 50%/i)
  assert.equal(versionItems.length, snapshot.evidenceItems.length)
  assert.deepEqual(
    new Set(versionItems.map((item) => `${item.sourceType}:${item.sourceId}`)),
    new Set(snapshot.evidenceItems.map((item) => `${item.sourceType}:${item.sourceId}`))
  )

  database = createReportDownload(database, scenario.agency, user.id, reportId)
  report = database.reports[0]
  assert.equal(report.readiness.pdfGenerated, true)
  assert.equal(report.pdfSnapshotVersion, report.snapshotVersion)
  const pdfText = decodePdfDataUrl(report.pdfDataUrl)
  assert.match(pdfText, /50%/)
  assert.match(pdfText, /\(Checks Run\)[\s\S]*?\(4\)/)
  assert.match(pdfText, /repeated incident was repaired/i)
  assert.match(pdfText, /\(PDF Generated\)[\s\S]*?\(Ready\)/)
})

test("the local scheduled execution path also reopens the issue and stales the report", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  let database = generateReport(scenario)
  const reportId = database.reports[0].id
  const issueId = database.issues[0].id
  database = createReportDownload(database, scenario.agency, user.id, reportId)

  database = recordScheduledCheckJob(database, scenario.agency.id, user.id, {
    startedAt: `${currentMonthToDate().periodEnd}T10:59:00.000Z`,
    checksDue: 1,
    attempts: [{ checkId: scenario.checkId, workflowId: scenario.workflowId, result: failedResult }],
  })
  database = timestampNewestRun(database, "11:00:00.000Z")

  assert.equal(database.issues.length, 1)
  assert.equal(database.issues[0].id, issueId)
  assert.equal(database.issues[0].status, "open")
  assert.equal(database.issues[0].occurrenceCount, 2)
  assert.equal(database.reports.find((report) => report.id === reportId)?.status, "blocked")
  assert.equal(database.reports.find((report) => report.id === reportId)?.pdfSnapshotVersion, null)
  assert.equal(database.checkJobRuns[0].status, "failed")
  assert.equal(database.checkJobRuns[0].failures, 1)
  assert.equal(database.auditEvents.some((event) => event.action === "scheduled_run"), true)
  assert.equal(database.auditEvents.some((event) => event.action === "reopened_occurrence"), true)
})

test("an explicit report-safe exception is disclosed in the client narrative", () => {
  const scenario = failedScenario()
  const exception = "The client accepts this known 500 response until the vendor migration on 31 July."
  scenario.database = updateIssueRecord(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.issueId,
    { status: "ignored", reportable: true, reportSafeSummary: exception }
  )
  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.status, "ready")
  assert.equal(report.readiness.latestEvidenceAcceptable, true)
  assert.equal(report.readiness.exceptionsDisclosed, true)
  assert.equal(report.snapshot?.issues[0].acceptedException, true)
  assert.match(report.narrative, /accepted client-safe exceptions/i)
  assert.match(report.narrative, /vendor migration on 31 july/i)
  assert.match(report.snapshot?.recommendations.join(" ") ?? "", /keep the accepted exception/i)
})

test("an accepted old failure cannot bless a newer inconclusive attempt", () => {
  const scenario = failedScenario()
  scenario.database = updateIssueRecord(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.issueId,
    {
      status: "ignored",
      reportable: true,
      reportSafeSummary: "The client accepts the original failed response while its vendor migration completes.",
    }
  )
  scenario.database = runWorkflowCheck(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    {
      status: "skipped",
      statusCode: null,
      latencyMs: null,
      assertionResults: [],
      safeResponseSummary: "No conclusive response was recorded.",
      errorMessage: "The endpoint did not produce conclusive evidence.",
    },
    "manual_run",
    `${currentMonthToDate().periodEnd}T11:00:00.000Z`
  )
  scenario.database = timestampNewestRun(scenario.database, "11:00:01.000Z")

  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.snapshot?.issues[0].sourceCheckRunId, scenario.database.issues[0].checkRunId)
  assert.equal(report.snapshot?.checkRuns[0].status, "skipped")
  assert.equal(report.readiness.latestEvidenceAcceptable, false)
  assert.equal(report.status, "blocked")
  assert.throws(
    () => createReportDownload(database, scenario.agency, user.id, report.id),
    /passing verification run/i,
  )
})

test("an accepted exception applies only to its check and cannot hide another failed check", () => {
  const scenario = failedScenario()
  const exception = "The client accepts this known 500 response until the vendor migration on 31 July."
  scenario.database = updateIssueRecord(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.issueId,
    { status: "ignored", reportable: true, reportSafeSummary: exception }
  )
  const originalRun = scenario.database.checkRuns[0]
  scenario.database = {
    ...scenario.database,
    checks: [
      ...scenario.database.checks,
      {
        ...scenario.database.checks[0],
        id: "unaccepted_failed_check",
        name: "Unaccepted failed check",
      },
    ],
    checkRuns: [
      ...scenario.database.checkRuns,
      {
        ...originalRun,
        id: "unaccepted_failed_check_run",
        checkId: "unaccepted_failed_check",
        errorMessage: "A separate business outcome failed.",
      },
    ],
  }

  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.status, "blocked")
  assert.equal(report.readiness.latestEvidenceAcceptable, false)
  assert.equal(report.snapshot?.workflowCoverage[0].status, "failed")
  assert.match(report.snapshot?.recommendations.join(" ") ?? "", /restore invoice intake monitor/i)
})

test("workflow coverage reflects the weakest latest result across multiple checks", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const originalFailure = scenario.database.checkRuns.find((run) => run.status === "failed")
  assert.ok(originalFailure)
  const createdAt = `${currentMonthToDate().periodEnd}T09:45:00.000Z`
  scenario.database = {
    ...scenario.database,
    checks: [
      ...scenario.database.checks,
      {
        ...scenario.database.checks[0],
        id: "secondary_failed_check",
        name: "Secondary failed check",
        lastRunAt: createdAt,
      },
    ],
    checkRuns: [
      ...scenario.database.checkRuns,
      {
        ...originalFailure,
        id: "secondary_failed_check_run",
        checkId: "secondary_failed_check",
        startedAt: createdAt,
        completedAt: createdAt,
        createdAt,
        errorMessage: "A second monitored outcome failed.",
      },
    ],
  }

  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.readiness.latestEvidenceAcceptable, false)
  assert.equal(report.snapshot?.workflowCoverage[0].status, "failed")
  assert.match(report.snapshot?.recommendations.join(" ") ?? "", /restore invoice intake monitor/i)
})

test("historical reports cannot be generated or refreshed after later issue and workflow transitions", () => {
  const scenario = failedScenario()
  assert.throws(
    () => generateReportRecord(scenario.database, scenario.agency, user.id, {
      clientId: scenario.clientId,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    }),
    /current UTC month.*audit history/i
  )

  const current = generateReport(scenario)
  const historicalReportId = current.reports[0].id
  const historical = {
    ...current,
    reports: current.reports.map((report) => report.id === historicalReportId
      ? { ...report, periodStart: "2026-06-01", periodEnd: "2026-06-30" }
      : report),
  }
  const laterTransitions = [
    {
      ...historical,
      issues: historical.issues.map((issue) => ({ ...issue, status: "ignored" as const, reportSafeSummary: "Accepted in July." })),
    },
    {
      ...historical,
      issues: historical.issues.map((issue) => ({ ...issue, reportable: false })),
    },
    {
      ...historical,
      workflows: historical.workflows.map((workflow) => ({ ...workflow, archivedAt: "2026-07-01T00:00:00.000Z" })),
    },
  ]

  laterTransitions.forEach((database) => {
    assert.throws(
      () => refreshReportRecord(database, scenario.agency, user.id, historicalReportId),
      /current UTC month.*audit history/i
    )
  })
})

test("an unresolved prior-month issue remains a blocker in the current report period", () => {
  const scenario = failedScenario()
  const priorMonth = "2026-06-30T10:00:00.000Z"
  scenario.database = {
    ...scenario.database,
    checkRuns: scenario.database.checkRuns.map((run) => ({
      ...run,
      startedAt: priorMonth,
      completedAt: priorMonth,
      createdAt: priorMonth,
    })),
    issues: scenario.database.issues.map((issue) => ({
      ...issue,
      createdAt: priorMonth,
      updatedAt: priorMonth,
    })),
  }
  scenario.database = runWorkflowCheck(
    scenario.database,
    scenario.agency.id,
    user.id,
    scenario.workflowId,
    scenario.checkId,
    healthyResult,
    "manual_run",
    `${currentMonthToDate().periodEnd}T10:00:00.000Z`
  )

  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(report.snapshot?.issues.length, 1)
  assert.equal(report.snapshot?.issues[0].status, "open")
  assert.equal(report.snapshot?.metrics.unresolvedHighRiskIssues, 1)
  assert.equal(report.readiness.issuesReviewed, false)
  assert.equal(report.status, "blocked")
})

test("every live field rendered into a report snapshot participates in current-evidence checks", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  const database = generateReport(scenario)
  const report = database.reports[0]

  assert.equal(reportSnapshotIsCurrent(report, database), true)

  const noOpSyncTimestamp = {
    ...database,
    issues: database.issues.map((issue) => ({ ...issue, updatedAt: "2099-01-01T00:00:00.000Z" })),
  }
  assert.equal(reportSnapshotIsCurrent(report, noOpSyncTimestamp), true)

  const renamedWorkflow = {
    ...database,
    workflows: database.workflows.map((workflow) =>
      workflow.id === scenario.workflowId ? { ...workflow, name: "Renamed invoice monitor" } : workflow
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, renamedWorkflow), false)

  const changedWorkflowExecution = {
    ...database,
    workflows: database.workflows.map((workflow) =>
      workflow.id === scenario.workflowId ? { ...workflow, expectedStatus: 204 } : workflow
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, changedWorkflowExecution), false)

  const changedCheckDefinition = {
    ...database,
    checks: database.checks.map((check) =>
      check.id === scenario.checkId
        ? { ...check, assertions: [{ id: "response", type: "response_exists" as const, enabled: true }] }
        : check
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, changedCheckDefinition), false)

  const disabledCheck = {
    ...database,
    checks: database.checks.map((check) =>
      check.id === scenario.checkId ? { ...check, enabled: false } : check
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, disabledCheck), false)

  const changedRunSummary = {
    ...database,
    checkRuns: database.checkRuns.map((run, index) =>
      index === 0 ? { ...run, safeResponseSummary: "The response body changed after snapshot generation." } : run
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, changedRunSummary), false)

  const changedIssueEvidence = {
    ...database,
    issues: database.issues.map((issue) =>
      issue.id === scenario.issueId ? { ...issue, reportSafeSummary: "The repair evidence was corrected." } : issue
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, changedIssueEvidence), false)

  const changedPresentation = {
    ...database,
    agencies: database.agencies.map((agency) =>
      agency.id === scenario.agency.id ? { ...agency, reportSenderName: "Updated report sender" } : agency
    ),
    clients: database.clients.map((client) =>
      client.id === scenario.clientId ? { ...client, website: "https://new.example" } : client
    ),
  }
  assert.equal(reportSnapshotIsCurrent(report, changedPresentation), false)
})

test("report snapshots never expose endpoint credentials, paths, or query tokens", () => {
  const scenario = failedScenario()
  scenario.database = repairThenVerifyHealthy(scenario)
  scenario.database = {
    ...scenario.database,
    workflows: scenario.database.workflows.map((workflow) => ({
      ...workflow,
      endpointUrl: "https://user:" + "password@hooks.example.com/private/token-123?api_key=secret#fragment",
    })),
    checkRuns: scenario.database.checkRuns.map((run, index) => index === 0 ? {
      ...run,
      safeResponseSummary: "Legacy body: customer-email@example.com token=secret-run-token",
      errorMessage: "Request to https://private.example.com failed with secret-error-token",
    } : run),
    issues: scenario.database.issues.map((issue) => ({
      ...issue,
      description: "Internal incident detail secret-issue-token for customer-email@example.com",
      reportSafeSummary: "",
    })),
  }

  const database = generateReport(scenario)
  const serialized = JSON.stringify(database.reports[0].snapshot)

  assert.equal(database.reports[0].snapshot?.workflowCoverage[0].endpointUrl, "Endpoint details withheld")
  assert.doesNotMatch(serialized, /password|token-123|api_key|secret|fragment|customer-email@example\.com|private\.example\.com/)
  assert.match(serialized, /response details were withheld|Issue details require report-safe review/)
})

test("the production migration invalidates stale PDFs and installs evidence triggers", () => {
  const migration = readFileSync("supabase/maintainflow_assurance_integrity_migration.sql", "utf8")
  const runner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")

  assert.match(migration, /snapshot_version integer not null default 0/)
  assert.match(migration, /verification_run_id uuid/)
  assert.doesNotMatch(migration, /pdf_storage_path\s*=\s*null/i)
  assert.match(migration, /check_runs_mark_assurance_reports_stale/)
  assert.match(migration, /issues_mark_assurance_reports_stale/)
  assert.match(migration, /issue_notes_mark_assurance_reports_stale/)
  assert.match(migration, /drop policy if exists report_pdfs_select_members on storage\.objects/)
  assert.match(migration, /drop policy if exists report_pdfs_insert_members on storage\.objects/)
  assert.match(migration, /drop policy if exists report_pdfs_update_members on storage\.objects/)
  assert.match(migration, /drop policy if exists report_pdfs_delete_admins on storage\.objects/)
  assert.match(migration, /Historical response details were withheld during the assurance migration/)
  assert.match(migration, /encrypted_auth_config = jsonb_set/)
  assert.match(migration, /'accept', 'accept-language', 'content-type'/)
  assert.match(runner, /maintainflow_assurance_integrity_migration\.sql/)
  assert.match(runner, /report_pdf_write_policies_absent/)
})
