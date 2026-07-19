import { isTimestampInReportPeriod } from "./report-period.ts"
import { aggregateReportMetrics, createReportNarrative } from "./reporting.ts"
import { isServiceIssuedCheckRun } from "./evidence-provenance.ts"
import type {
  Agency,
  Check,
  CheckRun,
  Client,
  CoreDatabase,
  Issue,
  IssueNote,
  Report,
  ReportItem,
  ReportSnapshot,
  ReportSnapshotEvidenceItem,
  ReportSnapshotPresentation,
  ReportStatus,
  Workflow,
} from "./types.ts"

export type ReportEvidenceRecords = {
  workflows: Workflow[]
  checks: Check[]
  checkRuns: CheckRun[]
  issues: Issue[]
  issueNotes: IssueNote[]
  agency?: Agency
  client?: Client
  agencies?: Agency[]
  clients?: Client[]
}

type SnapshotInput = ReportEvidenceRecords & {
  agency: Agency
  client: Client
  reportId: string
  periodStart: string
  periodEnd: string
  version: number
  generatedAt: string
}

export function buildReportSnapshot(input: SnapshotInput) {
  const evidence = reportEvidenceRecords({ ...input, agencyId: input.agency.id, clientId: input.client.id })
  const workflowById = new Map(evidence.workflows.map((workflow) => [workflow.id, workflow]))
  const latestRunByCheck = latestRunsByCheck(evidence.checkRuns)
  const issueNotesByIssue = groupIssueNotes(evidence.issueNotes)
  const sourceRunById = new Map(evidence.checkRuns.map((run) => [run.id, run]))
  const presentation = reportPresentation(input.agency, input.client)
  const evidenceFingerprint = fingerprintEvidence(evidence, presentation, input.periodStart, input.periodEnd)

  const metrics = aggregateReportMetrics({
    client: input.client,
    workflows: evidence.workflows,
    checkRuns: evidence.checkRuns,
    issues: evidence.issues,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  })
  metrics.issuesDetected = evidence.issues.length
  metrics.issuesResolved = evidence.issues.filter((issue) => issue.status === "resolved").length
  metrics.unresolvedHighRiskIssues = evidence.issues.filter(
    (issue) => ["high", "critical"].includes(issue.severity) && issue.status !== "resolved" && !isAcceptedException(issue)
  ).length

  const snapshotIssues = evidence.issues.map((issue) => {
    const sourceRun = sourceRunById.get(issue.checkRunId)
    const verificationRun = issue.verificationRunId ? sourceRunById.get(issue.verificationRunId) : undefined
    const latestCheckRun = latestRunByCheck.get(issue.checkId)
    const resolutionNoteIds = (issueNotesByIssue.get(issue.id) ?? []).map((note) => note.id)
    return {
      issueId: issue.id,
      workflowId: issue.workflowId,
      checkId: issue.checkId,
      workflowName: workflowById.get(issue.workflowId)?.name ?? "Workflow",
      sourceCheckRunId: issue.checkRunId,
      sourceEvidenceOrigin: "service" as const,
      verificationRunId: issue.verificationRunId,
      verificationEvidenceOrigin: issue.verificationRunId ? "service" as const : null,
      title: issue.title,
      severity: issue.severity,
      status: issue.status,
      reportSafeSummary: issue.reportSafeSummary,
      createdAt: issue.createdAt,
      resolvedAt: issue.resolvedAt,
      acceptedException: isAcceptedException(issue),
      recoveryVerified: Boolean(
        issue.status === "resolved" &&
          issue.reportSafeSummary.trim() &&
          verificationRun?.status === "healthy" &&
          verificationRun.id !== sourceRun?.id &&
          (!sourceRun || new Date(verificationRun.startedAt).getTime() > new Date(sourceRun.completedAt).getTime()) &&
          latestCheckRun?.status === "healthy" &&
          new Date(latestCheckRun.startedAt).getTime() >= new Date(verificationRun.startedAt).getTime()
      ),
      resolutionNoteIds,
    }
  })

  const narrative = appendClientSafeDisclosures(
    createReportNarrative(input.client.name, metrics),
    snapshotIssues
  )
  const recommendations = reportRecommendations(evidence.workflows, evidence.checkRuns, evidence.issues)
  const evidenceItems = snapshotEvidenceItems({
    reportId: input.reportId,
    version: input.version,
    generatedAt: input.generatedAt,
    evidence,
    workflowById,
    recommendations,
  })
  const snapshot: ReportSnapshot = {
    schemaVersion: 2,
    version: input.version,
    generatedAt: input.generatedAt,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    evidenceFingerprint,
    presentation,
    workflowIds: evidence.workflows.map((workflow) => workflow.id),
    checkIds: evidence.checks.map((check) => check.id),
    checkRunIds: evidence.checkRuns.map((run) => run.id),
    issueIds: evidence.issues.map((issue) => issue.id),
    resolutionNoteIds: evidence.issueNotes.map((note) => note.id),
    metrics,
    narrative,
    workflowCoverage: evidence.workflows.map((workflow) => {
      const runs = evidence.checkRuns.filter((run) => run.workflowId === workflow.id)
      const activeChecks = evidence.checks.filter((check) => check.workflowId === workflow.id)
      const latestRuns = activeChecks
        .map((check) => latestRunByCheck.get(check.id))
        .filter((run): run is CheckRun => Boolean(run))
      const coverageComplete = activeChecks.length > 0 && latestRuns.length === activeChecks.length
      const latestRun = latestRuns.reduce<CheckRun | undefined>(
        (latest, run) => !latest || new Date(run.createdAt).getTime() > new Date(latest.createdAt).getTime() ? run : latest,
        undefined
      )
      const weakestLatestRun = latestRuns.reduce<CheckRun | undefined>(
        (weakest, run) => !weakest || checkStatusRisk(run.status) > checkStatusRisk(weakest.status) ? run : weakest,
        undefined
      )
      return {
        workflowId: workflow.id,
        name: workflow.name,
        endpointUrl: "Endpoint details withheld",
        method: workflow.method,
        status: !coverageComplete || weakestLatestRun?.status === "skipped"
          ? "inconclusive"
          : weakestLatestRun?.status ?? "inconclusive",
        healthScore: coverageComplete && weakestLatestRun ? healthScoreForStatus(weakestLatestRun.status) : 0,
        checksRun: runs.length,
        lastCheckRunAt: latestRun?.createdAt ?? null,
      }
    }),
    checkRuns: evidence.checkRuns.map((run) => ({
      checkRunId: run.id,
      workflowId: run.workflowId,
      checkId: run.checkId,
      evidenceOrigin: "service",
      workflowName: workflowById.get(run.workflowId)?.name ?? "Workflow",
      status: run.status,
      statusCode: run.statusCode,
      latencyMs: run.latencyMs,
      summary: reportSafeCheckSummary(run),
      createdAt: run.createdAt,
    })),
    issues: snapshotIssues,
    recommendations,
    evidenceItems,
  }
  const readiness = evaluateReportReadiness(snapshot, narrative)

  return {
    snapshot,
    readiness,
    status: reportStatusFromReadiness(readiness),
    reportItems: evidenceItems.map((item) => reportItemFromSnapshot(input, item)),
  }
}

export function evaluateReportReadiness(
  snapshot: ReportSnapshot,
  narrative = snapshot.narrative,
  options: { pdfGenerated?: boolean; snapshotCurrent?: boolean } = {}
) {
  const serviceEvidenceOnly = reportSnapshotUsesOnlyServiceEvidence(snapshot)
  const latestRunByCheck = latestSnapshotRunsByCheck(snapshot)
  const activeCheckCoverageComplete = snapshot.checkIds.length > 0
    && snapshot.checkIds.every((checkId) => latestRunByCheck.has(checkId))
  const unresolvedIssues = snapshot.issues.filter(
    (issue) => issue.status !== "resolved" && !issue.acceptedException
  )
  const resolvedIssues = snapshot.issues.filter((issue) => issue.status === "resolved")
  const repairsAwaitingVerification = snapshot.issues.filter((issue) => issue.status === "in_review")
  const normalizedNarrative = normalizeText(narrative)
  const exceptionsDisclosed = snapshot.issues
    .filter((issue) => issue.acceptedException)
    .every((issue) => Boolean(issue.reportSafeSummary.trim()) && normalizedNarrative.includes(normalizeText(issue.reportSafeSummary)))
  const latestEvidenceAcceptable = serviceEvidenceOnly
    && activeCheckCoverageComplete
    && snapshot.checkIds.every((checkId) => {
      const run = latestRunByCheck.get(checkId)
      const acceptedLatestRun = Boolean(
        run
        && (run.status === "failed" || run.status === "degraded")
        && snapshot.issues.some((issue) =>
          issue.acceptedException
          && issue.checkId === checkId
          && issue.sourceCheckRunId === run.checkRunId
        )
      )
      return run?.status === "healthy" || acceptedLatestRun
    })

  return {
    clientSelected: true,
    periodSelected: true,
    workflowsIncluded: snapshot.workflowIds.length > 0,
    checksAvailable: serviceEvidenceOnly && snapshot.checkRunIds.length > 0,
    activeCheckCoverageComplete: serviceEvidenceOnly && activeCheckCoverageComplete,
    issuesReviewed: unresolvedIssues.length === 0,
    unresolvedReportableIssuesReviewed: unresolvedIssues.length === 0,
    latestEvidenceAcceptable,
    recoveryVerified:
      repairsAwaitingVerification.length === 0 && resolvedIssues.every((issue) =>
        issue.recoveryVerified
        && Boolean(issue.reportSafeSummary.trim())
        && normalizedNarrative.includes(normalizeText(issue.reportSafeSummary))
      ),
    exceptionsDisclosed,
    narrativeComplete: narrative.trim().length > 80,
    snapshotCurrent: options.snapshotCurrent ?? true,
    pdfGenerated: options.pdfGenerated ?? false,
  }
}

export function reportStatusFromReadiness(readiness: Record<string, boolean>): ReportStatus {
  if (!readiness.workflowsIncluded || !readiness.checksAvailable || !readiness.narrativeComplete) {
    return "draft"
  }
  const ready = Object.entries(readiness)
    .filter(([key]) => key !== "pdfGenerated")
    .every(([, value]) => value)
  return ready ? "ready" : "blocked"
}

export function normalizeReportStatus(value: unknown): ReportStatus {
  if (value === "draft" || value === "ready" || value === "sent" || value === "blocked") {
    return value
  }
  return value === "needs_review" || value === "stale" ? "blocked" : "draft"
}

export function reportSnapshotIsCurrent(report: Report, records: ReportEvidenceRecords) {
  if (
    !report.snapshot ||
    report.snapshot.schemaVersion !== 2 ||
    report.snapshotVersion < 1 ||
    report.snapshot.version !== report.snapshotVersion ||
    report.snapshot.periodStart !== report.periodStart ||
    report.snapshot.periodEnd !== report.periodEnd ||
    !reportSnapshotUsesOnlyServiceEvidence(report.snapshot)
  ) {
    return false
  }
  return report.snapshot.evidenceFingerprint === reportEvidenceFingerprint({
    ...records,
    agencyId: report.agencyId,
    clientId: report.clientId,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
  })
}

export function reportSnapshotUsesOnlyServiceEvidence(snapshot: ReportSnapshot) {
  if (!Array.isArray(snapshot.checkIds)) return false
  const activeCheckIds = new Set(snapshot.checkIds)
  const serviceRunIds = new Set(
    snapshot.checkRuns
      .filter((run) => run.evidenceOrigin === "service")
      .map((run) => run.checkRunId)
  )
  if (
    snapshot.checkRuns.length !== serviceRunIds.size
    || activeCheckIds.size !== snapshot.checkIds.length
    || snapshot.checkRunIds.length !== serviceRunIds.size
    || snapshot.checkRunIds.some((runId) => !serviceRunIds.has(runId))
  ) {
    return false
  }

  return snapshot.issues.every((issue) => {
    const verificationProvenanceMatches = issue.verificationRunId
      ? issue.verificationEvidenceOrigin === "service"
      : issue.verificationEvidenceOrigin === null
    return issue.sourceEvidenceOrigin === "service"
      && verificationProvenanceMatches
      && (issue.status !== "resolved" || Boolean(issue.verificationRunId))
  })
}

export function reportEvidenceFingerprint(input: ReportEvidenceRecords & {
  agencyId: string
  clientId: string
  periodStart: string
  periodEnd: string
}) {
  const agency = input.agency ?? input.agencies?.find((item) => item.id === input.agencyId)
  const client = input.client ?? input.clients?.find(
    (item) => item.id === input.clientId && item.agencyId === input.agencyId
  )
  if (!agency || !client) return ""
  return fingerprintEvidence(
    reportEvidenceRecords(input),
    reportPresentation(agency, client),
    input.periodStart,
    input.periodEnd
  )
}

export function markReportsStaleForEvidence(
  database: CoreDatabase,
  input: { agencyId: string; clientId: string; workflowId: string; occurredAt: string },
  now = new Date().toISOString()
) {
  let changed = false
  const reports = database.reports.map((report) => {
    if (
      report.agencyId !== input.agencyId ||
      report.clientId !== input.clientId ||
      report.status === "sent" ||
      !report.snapshot?.workflowIds.includes(input.workflowId) ||
      !isTimestampInReportPeriod(input.occurredAt, report)
    ) {
      return report
    }
    changed = true
    return staleReport(report, now)
  })
  return changed ? { ...database, reports } : database
}

export function reconcileReportStaleness(database: CoreDatabase, now = new Date().toISOString()) {
  let changed = false
  const reports = database.reports.map((report) => {
    if (report.status === "sent" || report.staleAt) return report
    if (reportSnapshotIsCurrent(report, database)) return report
    changed = true
    return staleReport(report, now)
  })
  return changed ? { ...database, reports } : database
}

export function staleReport(report: Report, now = new Date().toISOString()): Report {
  return {
    ...report,
    status: "blocked",
    readiness: { ...report.readiness, snapshotCurrent: false, pdfGenerated: false },
    staleAt: report.staleAt ?? now,
    pdfDataUrl: null,
    pdfSnapshotVersion: null,
    updatedAt: now,
  }
}

function reportEvidenceRecords(input: ReportEvidenceRecords & {
  agencyId?: string
  clientId: string
  periodStart: string
  periodEnd: string
}) {
  const period = { periodStart: input.periodStart, periodEnd: input.periodEnd }
  const workflows = input.workflows
    .filter((workflow) =>
      (!input.agencyId || workflow.agencyId === input.agencyId) &&
      workflow.clientId === input.clientId &&
      workflow.reportIncluded &&
      !workflow.archivedAt
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(canonicalWorkflowEvidence)
  const workflowIds = new Set(workflows.map((workflow) => workflow.id))
  const checks = input.checks
    .filter((check) =>
      (!input.agencyId || check.agencyId === input.agencyId)
      && workflowIds.has(check.workflowId)
      && check.enabled
      && !check.pendingSetup
    )
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId) || left.id.localeCompare(right.id))
    .map(canonicalCheckEvidence)
  const trustedCheckRuns = input.checkRuns
    .filter((run) =>
      (!input.agencyId || run.agencyId === input.agencyId) &&
      run.clientId === input.clientId &&
      workflowIds.has(run.workflowId) &&
      isServiceIssuedCheckRun(run)
    )
  const trustedCheckRunById = new Map(trustedCheckRuns.map((run) => [run.id, run]))
  const checkRuns = trustedCheckRuns
    .filter((run) =>
      isTimestampInReportPeriod(run.createdAt, period)
    )
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(canonicalCheckRunEvidence)
  const checkRunIds = new Set(checkRuns.map((run) => run.id))
  const issues = input.issues
    .filter((issue) => {
      const sourceRun = trustedCheckRunById.get(issue.checkRunId)
      return (!input.agencyId || issue.agencyId === input.agencyId)
      && issue.clientId === input.clientId
      && workflowIds.has(issue.workflowId)
      && issue.reportable
      && Boolean(sourceRun && runMatchesIssue(sourceRun, issue))
      && timestampOnOrBeforePeriodEnd(issue.createdAt, period.periodEnd)
    })
    .map((issue) => issueWithTrustedVerification(issue, trustedCheckRunById, trustedCheckRuns))
    .map((issue) => issueAsOfPeriodEnd(issue, period))
    .map(canonicalIssueEvidence)
    .filter((issue) =>
      issue.status !== "resolved"
      || isTimestampInReportPeriod(issue.createdAt, period)
      || (issue.resolvedAt ? isTimestampInReportPeriod(issue.resolvedAt, period) : false)
      || checkRunIds.has(issue.checkRunId)
    )
    .sort((left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() || left.id.localeCompare(right.id)
    )
  const issueIds = new Set(issues.map((issue) => issue.id))
  const issueNotes = input.issueNotes
    .filter((note) =>
      (!input.agencyId || note.agencyId === input.agencyId)
      && issueIds.has(note.issueId)
      && note.reportSafe
      && isTimestampInReportPeriod(note.createdAt, period)
    )
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
    .map((note) => ({ ...note, createdAt: canonicalEvidenceTimestamp(note.createdAt) }))
  return { workflows, checks, checkRuns, issues, issueNotes }
}

function issueWithTrustedVerification(
  issue: Issue,
  trustedCheckRunById: Map<string, CheckRun>,
  trustedCheckRuns: CheckRun[]
): Issue {
  const verificationRun = issue.verificationRunId
    ? trustedCheckRunById.get(issue.verificationRunId)
    : undefined
  const verificationIsTrusted = Boolean(verificationRun && runMatchesIssue(verificationRun, issue))
  if (issue.status !== "resolved" && (!issue.verificationRunId || verificationIsTrusted)) {
    return issue
  }
  const repairRecordedAt = new Date(issue.repairRecordedAt ?? "").getTime()
  const latestConclusiveRun = trustedCheckRuns
    .filter((run) =>
      runMatchesIssue(run, issue)
      && run.status !== "skipped"
      && Number.isFinite(repairRecordedAt)
      && new Date(run.startedAt).getTime() > repairRecordedAt
    )
    .sort(compareNewestCheckRun)[0]
  const resolutionIsTrusted = Boolean(
    verificationIsTrusted
    && verificationRun?.status === "healthy"
    && issue.resolutionNote.trim()
    && new Date(verificationRun.startedAt).getTime() > repairRecordedAt
    && new Date(issue.resolvedAt ?? "").getTime() === new Date(verificationRun.completedAt).getTime()
    && latestConclusiveRun?.status === "healthy"
  )
  if (issue.status === "resolved" && resolutionIsTrusted) {
    return issue
  }
  if (issue.status !== "resolved") {
    return { ...issue, verificationRunId: null }
  }
  const awaitingVerification = Boolean(issue.repairRecordedAt && issue.resolutionNote.trim())
  return {
    ...issue,
    status: awaitingVerification ? "in_review" : "open",
    resolvedAt: null,
    verificationRunId: null,
  }
}

function runMatchesIssue(run: CheckRun, issue: Issue) {
  return run.agencyId === issue.agencyId
    && run.clientId === issue.clientId
    && run.workflowId === issue.workflowId
    && run.checkId === issue.checkId
}

function compareNewestCheckRun(left: CheckRun, right: CheckRun) {
  return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
    || new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime()
    || right.id.localeCompare(left.id)
}

function canonicalWorkflowEvidence(workflow: Workflow): Workflow {
  return {
    ...workflow,
    lastCheckRunAt: canonicalNullableEvidenceTimestamp(workflow.lastCheckRunAt),
    archivedAt: canonicalNullableEvidenceTimestamp(workflow.archivedAt),
    createdAt: canonicalEvidenceTimestamp(workflow.createdAt),
    updatedAt: canonicalEvidenceTimestamp(workflow.updatedAt),
  }
}

function canonicalCheckRunEvidence(run: CheckRun): CheckRun {
  return {
    ...run,
    startedAt: canonicalEvidenceTimestamp(run.startedAt),
    completedAt: canonicalEvidenceTimestamp(run.completedAt),
    createdAt: canonicalEvidenceTimestamp(run.createdAt),
  }
}

function canonicalCheckEvidence(check: Check): Check {
  return {
    ...check,
    lastRunAt: canonicalNullableEvidenceTimestamp(check.lastRunAt),
    nextRunAt: canonicalNullableEvidenceTimestamp(check.nextRunAt),
    createdAt: canonicalEvidenceTimestamp(check.createdAt),
    updatedAt: canonicalEvidenceTimestamp(check.updatedAt),
  }
}

function canonicalIssueEvidence(issue: Issue): Issue {
  return {
    ...issue,
    snoozedUntil: canonicalNullableEvidenceTimestamp(issue.snoozedUntil),
    repairRecordedAt: canonicalNullableEvidenceTimestamp(issue.repairRecordedAt),
    resolvedAt: canonicalNullableEvidenceTimestamp(issue.resolvedAt),
    createdAt: canonicalEvidenceTimestamp(issue.createdAt),
    updatedAt: canonicalEvidenceTimestamp(issue.updatedAt),
  }
}

function canonicalNullableEvidenceTimestamp(value: string | null) {
  return value ? canonicalEvidenceTimestamp(value) : null
}

function canonicalEvidenceTimestamp(value: string) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value
}

function issueAsOfPeriodEnd(issue: Issue, period: { periodStart: string; periodEnd: string }): Issue {
  const repairRecordedAt = timestampOnOrBeforePeriodEnd(issue.repairRecordedAt, period.periodEnd)
    ? issue.repairRecordedAt
    : null
  const resolutionWasProven =
    issue.status === "resolved"
    && Boolean(issue.verificationRunId)
    && timestampOnOrBeforePeriodEnd(issue.resolvedAt, period.periodEnd)

  if (resolutionWasProven) {
    return { ...issue, repairRecordedAt }
  }

  if (issue.status !== "resolved") {
    if (issue.repairRecordedAt && !repairRecordedAt) {
      return {
        ...issue,
        status: "open",
        repairRecordedAt: null,
        resolvedAt: null,
        verificationRunId: null,
        resolutionNote: "",
        reportSafeSummary: "",
      }
    }
    return issue
  }

  return {
    ...issue,
    status: repairRecordedAt ? "in_review" : "open",
    repairRecordedAt,
    resolvedAt: null,
    verificationRunId: null,
    resolutionNote: repairRecordedAt ? issue.resolutionNote : "",
    reportSafeSummary: repairRecordedAt ? issue.reportSafeSummary : "",
  }
}

function timestampOnOrBeforePeriodEnd(timestamp: string | null, periodEnd: string) {
  if (!timestamp) return false
  const value = new Date(timestamp).getTime()
  const end = new Date(`${periodEnd}T23:59:59.999Z`).getTime()
  return Number.isFinite(value) && Number.isFinite(end) && value <= end
}

function fingerprintEvidence(
  records: ReportEvidenceRecords,
  presentation: ReportSnapshotPresentation,
  periodStart: string,
  periodEnd: string
) {
  const parts = [
    stableEvidencePart("period", { periodStart, periodEnd }),
    stableEvidencePart("presentation", presentation),
    ...records.workflows.map((workflow) => stableEvidencePart("workflow", {
      id: workflow.id,
      name: workflow.name,
      type: workflow.type,
      environment: workflow.environment,
      endpointUrl: workflow.endpointUrl,
      method: workflow.method,
      headers: workflow.headers,
      requestBody: workflow.requestBody,
      expectedStatus: workflow.expectedStatus,
      timeoutSeconds: workflow.timeoutSeconds,
      maxLatencyMs: workflow.maxLatencyMs,
      frequencyMinutes: workflow.frequencyMinutes,
      retries: workflow.retries,
      status: workflow.status,
      healthScore: workflow.healthScore,
      reportIncluded: workflow.reportIncluded,
      storeRawResponse: workflow.storeRawResponse,
      archivedAt: workflow.archivedAt,
    })),
    ...records.checks.map((check) => stableEvidencePart("check", {
      id: check.id,
      workflowId: check.workflowId,
      name: check.name,
      type: check.type,
      pluginId: check.pluginId,
      configJson: check.configJson,
      enabled: check.enabled,
      pendingSetup: check.pendingSetup,
      scheduleMinutes: check.scheduleMinutes,
      assertions: check.assertions,
    })),
    ...records.checkRuns.map((run) => stableEvidencePart("check_run", {
      id: run.id,
      workflowId: run.workflowId,
      checkId: run.checkId,
      status: run.status,
      evidenceOrigin: run.evidenceOrigin,
      statusCode: run.statusCode,
      latencyMs: run.latencyMs,
      assertionResults: run.assertionResults,
      safeResponseSummary: run.safeResponseSummary,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      createdAt: run.createdAt,
    })),
    ...records.issues.map((issue) => stableEvidencePart("issue", {
      id: issue.id,
      workflowId: issue.workflowId,
      checkRunId: issue.checkRunId,
      verificationRunId: issue.verificationRunId,
      checkId: issue.checkId,
      severity: issue.severity,
      status: issue.status,
      title: issue.title,
      description: issue.description,
      reportable: issue.reportable,
      occurrenceCount: issue.occurrenceCount,
      snoozedUntil: issue.snoozedUntil,
      repairRecordedAt: issue.repairRecordedAt,
      resolvedAt: issue.resolvedAt,
      resolutionNote: issue.resolutionNote,
      reportSafeSummary: issue.reportSafeSummary,
      createdAt: issue.createdAt,
    })),
    ...records.issueNotes.map((note) => stableEvidencePart("issue_note", {
      id: note.id,
      issueId: note.issueId,
      body: note.body,
      reportSafe: note.reportSafe,
      createdAt: note.createdAt,
    })),
  ].sort()
  let hash = 2166136261
  for (const character of parts.join("|") ) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `mf-report-v2-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function reportPresentation(agency: Agency, client: Client): ReportSnapshotPresentation {
  return {
    agency: {
      name: agency.name,
      reportSenderName: agency.reportSenderName,
      reportSenderEmail: agency.reportSenderEmail,
    },
    client: {
      name: client.name,
      website: client.website,
      reportRecipientEmail: client.reportRecipientEmail,
    },
  }
}

function stableEvidencePart(kind: string, value: Record<string, unknown>) {
  return `${kind}:${JSON.stringify(stableEvidenceValue(value))}`
}

function stableEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableEvidenceValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableEvidenceValue(item)])
  )
}

function latestRunsByCheck(runs: CheckRun[]) {
  const latest = new Map<string, CheckRun>()
  runs.forEach((run) => {
    if (!latest.has(run.checkId)) latest.set(run.checkId, run)
  })
  return latest
}

function latestSnapshotRunsByCheck(snapshot: ReportSnapshot) {
  const latest = new Map<string, ReportSnapshot["checkRuns"][number]>()
  snapshot.checkRuns.forEach((run) => {
    if (!latest.has(run.checkId)) latest.set(run.checkId, run)
  })
  return latest
}

function groupIssueNotes(notes: IssueNote[]) {
  const grouped = new Map<string, IssueNote[]>()
  notes.forEach((note) => grouped.set(note.issueId, [...(grouped.get(note.issueId) ?? []), note]))
  return grouped
}

function isAcceptedException(issue: Issue) {
  return issue.status === "ignored" && issue.reportable && issue.reportSafeSummary.trim().length > 0
}

function appendClientSafeDisclosures(
  narrative: string,
  issues: ReportSnapshot["issues"]
) {
  const resolutionProof = issues
    .filter((issue) => issue.status === "resolved" && issue.recoveryVerified && issue.reportSafeSummary.trim())
    .map((issue) => issue.reportSafeSummary.trim())
  const acceptedExceptions = issues
    .filter((issue) => issue.acceptedException)
    .map((issue) => issue.reportSafeSummary.trim())
  return [
    narrative,
    resolutionProof.length ? `Verified recovery: ${resolutionProof.join(" ")}` : "",
    acceptedExceptions.length ? `Accepted client-safe exceptions: ${acceptedExceptions.join(" ")}` : "",
  ].filter(Boolean).join("\n\n")
}

function reportRecommendations(workflows: Workflow[], runs: CheckRun[], issues: Issue[]) {
  const latest = latestRunsByCheck(runs)
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]))
  const unhealthy = [...latest.values()].filter((run) => run.status === "failed" || run.status === "degraded")
  const inconclusive = [...latest.values()].filter((run) => run.status === "skipped")
  const blockers = issues.filter((issue) => issue.status !== "resolved" && !isAcceptedException(issue))
  const exceptions = issues.filter(isAcceptedException)
  const recommendations = [
    ...unhealthy.map((run) => {
      const workflow = workflowById.get(run.workflowId)?.name ?? "Workflow"
      return run.status === "failed"
        ? `Restore ${workflow} and record a healthy verification run before sharing this report.`
        : `Review degraded evidence for ${workflow} and verify stable health before client delivery.`
    }),
    ...inconclusive.map((run) =>
      `Rerun ${workflowById.get(run.workflowId)?.name ?? "the workflow"}; the latest test was inconclusive and cannot support client delivery.`
    ),
    ...(blockers.length ? ["Resolve or explicitly review every reportable issue before client delivery."] : []),
    ...exceptions.map((issue) => `Keep the accepted exception for ${workflowById.get(issue.workflowId)?.name ?? "this workflow"} visible in the client narrative.`),
  ]
  if (recommendations.length === 0) {
    recommendations.push("Maintain the current monitoring cadence and review new evidence before the next client report.")
  }
  return [...new Set(recommendations)]
}

function snapshotEvidenceItems(input: {
  reportId: string
  version: number
  generatedAt: string
  evidence: ReportEvidenceRecords
  workflowById: Map<string, Workflow>
  recommendations: string[]
}): ReportSnapshotEvidenceItem[] {
  const { evidence } = input
  return [
    ...evidence.workflows.map((workflow) => ({
      id: reportItemId(),
      sourceType: "workflow" as const,
      sourceId: workflow.id,
      title: workflow.name,
      body: `${workflow.method} endpoint details were withheld and the workflow was included in snapshot v${input.version}.`,
      reportSafe: true as const,
      createdAt: input.generatedAt,
    })),
    ...evidence.checkRuns.map((run) => ({
      id: reportItemId(),
      sourceType: "check_run" as const,
      sourceId: run.id,
      title: `${input.workflowById.get(run.workflowId)?.name ?? "Workflow"} check ${run.status}`,
      body: reportSafeCheckSummary(run),
      reportSafe: true as const,
      createdAt: run.createdAt,
    })),
    ...evidence.issues.map((issue) => ({
      id: reportItemId(),
      sourceType: "issue" as const,
      sourceId: issue.id,
      title: issue.title,
      body: issue.reportSafeSummary || "Issue details require report-safe review.",
      reportSafe: true as const,
      createdAt: issue.resolvedAt ?? issue.repairRecordedAt ?? issue.createdAt,
    })),
    ...evidence.issueNotes.map((note) => ({
      id: reportItemId(),
      sourceType: "issue" as const,
      sourceId: note.id,
      title: "Report-safe resolution note",
      body: note.body,
      reportSafe: true as const,
      createdAt: note.createdAt,
    })),
    ...input.recommendations.map((recommendation, index) => ({
      id: reportItemId(),
      sourceType: "recommendation" as const,
      sourceId: `rec_${input.reportId}_${input.version}_${index}`,
      title: "Recommendation",
      body: recommendation,
      reportSafe: true as const,
      createdAt: input.generatedAt,
    })),
  ]
}

function reportSafeCheckSummary(run: CheckRun) {
  if (run.status === "skipped") {
    return "The check was inconclusive; response details were withheld."
  }
  if (run.status !== "healthy") {
    return typeof run.statusCode === "number"
      ? `The check returned HTTP ${run.statusCode}; response details were withheld.`
      : "The check did not meet its expected outcome; response details were withheld."
  }
  if (
    /^(JSON|HTML|Text) response was empty\.$/.test(run.safeResponseSummary)
    || /^(JSON|HTML|Text) response received \(\d+ bytes\); body content was not stored\.$/.test(run.safeResponseSummary)
    || run.safeResponseSummary === "No response body was stored."
    || run.safeResponseSummary === "Historical response details were withheld during the assurance migration."
  ) {
    return run.safeResponseSummary
  }
  return "The check completed successfully; response details were withheld."
}

function reportItemFromSnapshot(input: SnapshotInput, item: ReportSnapshotEvidenceItem): ReportItem {
  return {
    id: item.id,
    agencyId: input.agency.id,
    reportId: input.reportId,
    clientId: input.client.id,
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    title: item.title,
    body: item.body,
    reportSafe: true,
    snapshotVersion: input.version,
    createdAt: item.createdAt,
  }
}

function reportItemId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return "10000000-0000-4000-8000-000000000000".replace(/[018]/g, (value) =>
    (Number(value) ^ (Math.random() * 16) >> (Number(value) / 4)).toString(16)
  )
}

function healthScoreForStatus(status: CheckRun["status"]) {
  if (status === "healthy") return 100
  if (status === "degraded") return 68
  if (status === "failed") return 24
  return 0
}

function checkStatusRisk(status: CheckRun["status"]) {
  if (status === "failed") return 4
  if (status === "degraded") return 3
  if (status === "skipped") return 2
  return 1
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}
