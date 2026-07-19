import { isTimestampInReportPeriod } from "../report-period.ts"
import { isServiceIssuedCheckRun } from "../evidence-provenance.ts"
import type { Agency, CheckRun, Client, CoreDatabase, Issue, Report, ReportItem, Workflow } from "../types.ts"

export type ReportViewModel = {
  reportId: string
  agency: {
    id: string
    name: string
    reportSenderName: string
    reportSenderEmail: string
  }
  client: {
    id: string
    name: string
    website: string
    reportRecipientEmail: string
  }
  period: {
    start: string
    end: string
    label: string
  }
  generatedAt: string
  summary: string
  scorecard: {
    workflowsMonitored: number
    checksRun: number
    passRate: number
    issuesDetected: number
    issuesResolved: number
    unresolvedHighRiskIssues: number
    averageLatencyMs: number | null
  }
  workflowCoverage: Array<{
    workflowId: string
    name: string
    endpointUrl: string
    method: string
    status: string
    healthScore: number
    checksRun: number
    lastCheckRunAt: string | null
  }>
  checkRuns: Array<{
    checkRunId: string
    workflowId: string
    workflowName: string
    status: string
    statusCode: number | null
    latencyMs: number | null
    summary: string
    createdAt: string
  }>
  issues: ReportIssueView[]
  resolvedIssues: ReportIssueView[]
  recommendations: string[]
  evidenceItems: Array<{
    id: string
    sourceType: ReportItem["sourceType"]
    sourceId: string
    title: string
    body: string
    reportSafe: boolean
    createdAt: string
  }>
  reportSafeNarrative: string
}

type ReportIssueView = {
  issueId: string
  workflowId: string
  workflowName: string
  title: string
  severity: string
  status: string
  reportSafeSummary: string
  createdAt: string
  resolvedAt: string | null
}

export function createReportViewModel(input: {
  database: CoreDatabase
  agency: Agency
  report: Report
}): ReportViewModel {
  const { database, agency, report } = input
  const client = mustFindClient(database, report)
  return createReportViewModelFromRecords({
    agency,
    client,
    report,
    workflows: database.workflows,
    checkRuns: database.checkRuns,
    issues: database.issues,
    reportItems: database.reportItems,
  })
}

export function createReportViewModelFromRecords(input: {
  agency: Agency
  client: Client
  report: Report
  workflows: Workflow[]
  checkRuns: CheckRun[]
  issues: Issue[]
  reportItems: ReportItem[]
}): ReportViewModel {
  const { agency, client, report } = input
  if (report.snapshot?.schemaVersion === 2 && report.snapshot.presentation) {
    const presentation = report.snapshot.presentation
    return {
      reportId: report.id,
      agency: {
        id: agency.id,
        name: presentation.agency.name,
        reportSenderName: presentation.agency.reportSenderName,
        reportSenderEmail: presentation.agency.reportSenderEmail,
      },
      client: {
        id: client.id,
        name: presentation.client.name,
        website: presentation.client.website,
        reportRecipientEmail: presentation.client.reportRecipientEmail,
      },
      period: {
        start: report.periodStart,
        end: report.periodEnd,
        label: `${report.periodStart} to ${report.periodEnd}`,
      },
      generatedAt: report.snapshot.generatedAt,
      summary: report.snapshot.narrative,
      scorecard: report.snapshot.metrics,
      workflowCoverage: report.snapshot.workflowCoverage,
      checkRuns: report.snapshot.checkRuns,
      issues: report.snapshot.issues
        .filter((issue) => issue.status !== "resolved")
        .map(snapshotIssueView),
      resolvedIssues: report.snapshot.issues
        .filter((issue) => issue.status === "resolved")
        .map(snapshotIssueView),
      recommendations: report.snapshot.recommendations,
      evidenceItems: report.snapshot.evidenceItems,
      reportSafeNarrative: report.snapshot.narrative,
    }
  }
  const period = { periodStart: report.periodStart, periodEnd: report.periodEnd }
  const workflows = input.workflows
    .filter((workflow) => workflow.agencyId === agency.id && workflow.clientId === client.id && workflow.reportIncluded && !workflow.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name))
  const workflowIds = new Set(workflows.map((workflow) => workflow.id))
  const runs = input.checkRuns
    .filter((run) => isServiceIssuedCheckRun(run)
      && run.agencyId === agency.id
      && run.clientId === client.id
      && workflowIds.has(run.workflowId)
      && isTimestampInReportPeriod(run.createdAt, period))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const serviceRunIds = new Set(runs.map((run) => run.id))
  const issues = input.issues
    .filter((issue) => issue.agencyId === agency.id
      && issue.clientId === client.id
      && workflowIds.has(issue.workflowId)
      && serviceRunIds.has(issue.checkRunId)
      && issue.reportable
      && isTimestampInReportPeriod(issue.createdAt, period))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const reportItems = input.reportItems
    .filter((item) => item.agencyId === agency.id && item.reportId === report.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]))

  return {
    reportId: report.id,
    agency: {
      id: agency.id,
      name: agency.name,
      reportSenderName: agency.reportSenderName,
      reportSenderEmail: agency.reportSenderEmail,
    },
    client: {
      id: client.id,
      name: client.name,
      website: client.website,
      reportRecipientEmail: client.reportRecipientEmail,
    },
    period: {
      start: report.periodStart,
      end: report.periodEnd,
      label: `${report.periodStart} to ${report.periodEnd}`,
    },
    generatedAt: report.updatedAt || report.createdAt,
    summary: report.narrative,
    scorecard: {
      workflowsMonitored: report.metrics.workflowsMonitored,
      checksRun: report.metrics.checksRun,
      passRate: report.metrics.passRate,
      issuesDetected: report.metrics.issuesDetected,
      issuesResolved: report.metrics.issuesResolved,
      unresolvedHighRiskIssues: report.metrics.unresolvedHighRiskIssues,
      averageLatencyMs: report.metrics.averageLatencyMs,
    },
    workflowCoverage: workflows.map((workflow) => workflowCoverage(workflow, runs)),
    checkRuns: runs.map((run) => checkRunView(run, workflowById.get(run.workflowId))),
    issues: issues.filter((issue) => issue.status !== "resolved").map((issue) => issueView(issue, workflowById.get(issue.workflowId))),
    resolvedIssues: issues.filter((issue) => issue.status === "resolved").map((issue) => issueView(issue, workflowById.get(issue.workflowId))),
    recommendations: reportItems
      .filter((item) => item.sourceType === "recommendation" && item.reportSafe)
      .map((item) => item.body),
    evidenceItems: reportItems
      .filter((item) => item.reportSafe)
      .map((item) => ({
        id: item.id,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        title: item.title,
        body: item.body,
        reportSafe: item.reportSafe,
        createdAt: item.createdAt,
      })),
    reportSafeNarrative: buildReportSafeNarrative(report.narrative, issues),
  }
}

function snapshotIssueView(issue: NonNullable<Report["snapshot"]>["issues"][number]): ReportIssueView {
  return {
    issueId: issue.issueId,
    workflowId: issue.workflowId,
    workflowName: issue.workflowName,
    title: issue.title,
    severity: issue.severity,
    status: issue.status,
    reportSafeSummary: issue.reportSafeSummary,
    createdAt: issue.createdAt,
    resolvedAt: issue.resolvedAt,
  }
}

function mustFindClient(database: CoreDatabase, report: Report): Client {
  const client = database.clients.find((item) => item.agencyId === report.agencyId && item.id === report.clientId)
  if (!client) {
    throw new Error("Report client was not found for this agency.")
  }

  return client
}

function workflowCoverage(workflow: Workflow, runs: CheckRun[]) {
  const workflowRuns = runs.filter((run) => run.workflowId === workflow.id)
  return {
    workflowId: workflow.id,
    name: workflow.name,
    endpointUrl: workflow.endpointUrl,
    method: workflow.method,
    status: workflow.status,
    healthScore: workflow.healthScore,
    checksRun: workflowRuns.length,
    lastCheckRunAt: workflow.lastCheckRunAt,
  }
}

function checkRunView(run: CheckRun, workflow: Workflow | undefined) {
  return {
    checkRunId: run.id,
    workflowId: run.workflowId,
    workflowName: workflow?.name ?? "Workflow",
    status: run.status,
    statusCode: run.statusCode,
    latencyMs: run.latencyMs,
    summary: run.errorMessage || run.safeResponseSummary,
    createdAt: run.createdAt,
  }
}

function issueView(issue: Issue, workflow: Workflow | undefined): ReportIssueView {
  return {
    issueId: issue.id,
    workflowId: issue.workflowId,
    workflowName: workflow?.name ?? "Workflow",
    title: issue.title,
    severity: issue.severity,
    status: issue.status,
    reportSafeSummary: issue.reportSafeSummary,
    createdAt: issue.createdAt,
    resolvedAt: issue.resolvedAt,
  }
}

function buildReportSafeNarrative(narrative: string, issues: Issue[]) {
  const resolvedSummaries = issues
    .filter((issue) => issue.status === "resolved" && issue.reportSafeSummary.trim())
    .map((issue) => issue.reportSafeSummary.trim())

  if (resolvedSummaries.length === 0) {
    return narrative
  }

  return `${narrative}\n\nResolved maintenance proof: ${resolvedSummaries.join(" ")}`
}
