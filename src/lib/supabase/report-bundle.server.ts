import { createReportViewModelFromRecords } from "../core/reports/report-view-model.ts"
import {
  buildReportSnapshot,
  evaluateReportReadiness,
  normalizeReportStatus,
  reportSnapshotIsCurrent,
  reportStatusFromReadiness,
} from "../core/report-state.ts"
import type { Agency, Check, CheckRun, Client, Issue, IssueNote, Report, ReportItem, ReportMetrics, Workflow } from "../core/types.ts"
import { sanitizeStoredWorkflowHeaders } from "../core/workflow-auth.ts"
import { sanitizeAssertionResults } from "../core/assertions.ts"
import { normalizeCheckRunEvidenceOrigin } from "../core/evidence-provenance.ts"
import { validateReportPeriod } from "../core/report-period.ts"

type Row = Record<string, unknown>

export class ReportBundleError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ReportBundleError"
    this.status = status
  }
}

export type ReportBundleConfig = {
  anonKey: string
  restUrl: string
}

export type ReportBundle = {
  agency: Agency
  client: Client
  report: Report
  workflows: Workflow[]
  checks: Check[]
  checkRuns: CheckRun[]
  issues: Issue[]
  issueNotes: IssueNote[]
  reportItems: ReportItem[]
}

export async function loadAuthorizedReportBundle(
  config: ReportBundleConfig,
  token: string,
  reportId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReportBundle> {
  const reportRows = await supabaseRows<Row>(
    config,
    token,
    `reports?${query({
      select: "id,agency_id,client_id,period_start,period_end,status,narrative,readiness_json,metrics_json,snapshot_version,snapshot_json,evidence_fingerprint,stale_at,pdf_storage_path,pdf_snapshot_version,sent_at,created_at,updated_at",
      id: `eq.${reportId}`,
      limit: "1",
    })}`,
    fetchImpl
  )
  const reportRow = reportRows[0]
  if (!reportRow) {
    throw new ReportBundleError(404, "Report was not found for this user.")
  }
  const report = reportFromRow(reportRow)

  const [agencyRows, clientRows, workflowRows, checkRows, checkRunRows, issueRows, issueNoteRows, itemRows] = await Promise.all([
    supabaseRows<Row>(
      config,
      token,
      `agencies?${query({ select: "id,name,slug,plan,trial_ends_at,stripe_customer_id,stripe_subscription_id,report_sender_name,report_sender_email,created_at,updated_at", id: `eq.${report.agencyId}`, limit: "1" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `clients?${query({ select: "id,agency_id,name,slug,website,owner_user_id,report_recipient_email,report_cadence,notes,archived_at,created_at,updated_at", id: `eq.${report.clientId}`, agency_id: `eq.${report.agencyId}`, limit: "1" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `workflows?${query({ select: "*", agency_id: `eq.${report.agencyId}`, client_id: `eq.${report.clientId}`, order: "name.asc" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `checks?${query({ select: "*", agency_id: `eq.${report.agencyId}`, order: "created_at.asc" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `check_runs?${query({ select: "*", agency_id: `eq.${report.agencyId}`, client_id: `eq.${report.clientId}`, evidence_origin: "eq.service", order: "created_at.desc" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `issues?${query({ select: "*", agency_id: `eq.${report.agencyId}`, client_id: `eq.${report.clientId}`, reportable: "eq.true", order: "created_at.desc" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `issue_notes?${query({ select: "*", agency_id: `eq.${report.agencyId}`, report_safe: "eq.true", order: "created_at.asc" })}`,
      fetchImpl
    ),
    supabaseRows<Row>(
      config,
      token,
      `report_items?${query({ select: "id,agency_id,report_id,client_id,source_type,source_id,title,body,report_safe,snapshot_version,created_at", report_id: `eq.${report.id}`, agency_id: `eq.${report.agencyId}`, report_safe: "eq.true", snapshot_version: `eq.${report.snapshotVersion}`, order: "created_at.asc" })}`,
      fetchImpl
    ),
  ])

  const agency = agencyRows[0] ? agencyFromRow(agencyRows[0]) : null
  const client = clientRows[0] ? clientFromRow(clientRows[0]) : null
  if (!agency || !client) {
    throw new ReportBundleError(404, "Report workspace data was not found for this user.")
  }

  return {
    agency,
    client,
    report,
    workflows: workflowRows.map(workflowFromRow),
    checks: checkRows.map(checkFromRow),
    checkRuns: checkRunRows.map(checkRunFromRow),
    issues: issueRows.map(issueFromRow),
    issueNotes: issueNoteRows.map(issueNoteFromRow),
    reportItems: itemRows.map(reportItemFromRow),
  }
}

export function reportBundleSnapshotIsCurrent(bundle: ReportBundle) {
  const snapshot = bundle.report.snapshot
  if (
    !snapshot
    || validateReportPeriod({
      periodStart: bundle.report.periodStart,
      periodEnd: bundle.report.periodEnd,
    })
    || snapshot.periodStart !== bundle.report.periodStart
    || snapshot.periodEnd !== bundle.report.periodEnd
    || !reportSnapshotIsCurrent(bundle.report, bundle)
  ) return false

  const rebuilt = buildReportSnapshot({
    agency: bundle.agency,
    client: bundle.client,
    reportId: bundle.report.id,
    periodStart: bundle.report.periodStart,
    periodEnd: bundle.report.periodEnd,
    version: bundle.report.snapshotVersion,
    generatedAt: snapshot.generatedAt,
    workflows: bundle.workflows,
    checks: bundle.checks,
    checkRuns: bundle.checkRuns,
    issues: bundle.issues,
    issueNotes: bundle.issueNotes,
  })
  const canonical = rebuilt.snapshot
  const expectedReadiness = evaluateReportReadiness(canonical, snapshot.narrative)
  const expectedStatus = reportStatusFromReadiness(expectedReadiness)
  const storedStatusMatches = bundle.report.status === expectedStatus
    || (bundle.report.status === "sent" && expectedStatus === "ready")

  return storedStatusMatches
    && stableSerialize(readinessProjection(bundle.report.readiness)) === stableSerialize(readinessProjection(expectedReadiness))
    && stableSerialize(snapshotEvidenceProjection(snapshot)) === stableSerialize(snapshotEvidenceProjection(canonical))
}

export function createBundleViewModel(bundle: ReportBundle) {
  return createReportViewModelFromRecords({
    agency: bundle.agency,
    client: bundle.client,
    report: bundle.report,
    workflows: bundle.workflows,
    checkRuns: bundle.checkRuns,
    issues: bundle.issues,
    reportItems: bundle.reportItems,
  })
}

async function supabaseRows<T>(config: ReportBundleConfig, token: string, path: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${config.restUrl}/${path}`, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    throw new ReportBundleError(response.status || 502, "Could not load report data.")
  }
  return (await response.json().catch(() => [])) as T[]
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function reportFromRow(row: Row): Report {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    periodStart: String(row.period_start ?? ""),
    periodEnd: String(row.period_end ?? ""),
    status: normalizeReportStatus(row.status),
    narrative: String(row.narrative ?? ""),
    readiness: jsonObject(row.readiness_json, {}),
    metrics: jsonObject<ReportMetrics>(row.metrics_json, {
      workflowsMonitored: 0,
      checksRun: 0,
      passRate: 0,
      issuesDetected: 0,
      issuesResolved: 0,
      unresolvedHighRiskIssues: 0,
      averageLatencyMs: null,
    }),
    snapshotVersion: Number(row.snapshot_version ?? 0),
    snapshot: nullableJsonObject<NonNullable<Report["snapshot"]>>(row.snapshot_json),
    evidenceFingerprint: String(row.evidence_fingerprint ?? ""),
    staleAt: nullableTime(row.stale_at),
    pdfDataUrl: null,
    pdfStoragePath: typeof row.pdf_storage_path === "string" ? row.pdf_storage_path : null,
    pdfSnapshotVersion: typeof row.pdf_snapshot_version === "number" ? row.pdf_snapshot_version : null,
    sentAt: nullableTime(row.sent_at),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function agencyFromRow(row: Row): Agency {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    plan: (row.plan as Agency["plan"]) ?? "free",
    trialEndsAt: nullableTime(row.trial_ends_at),
    stripeCustomerId: String(row.stripe_customer_id ?? ""),
    stripeSubscriptionId: String(row.stripe_subscription_id ?? ""),
    stripeSubscriptionStatus: String(row.stripe_subscription_status ?? "") as Agency["stripeSubscriptionStatus"],
    complimentaryEntitlement: Boolean(row.complimentary_entitlement),
    complimentaryEntitlementReason: String(row.complimentary_entitlement_reason ?? ""),
    reportSenderName: String(row.report_sender_name ?? ""),
    reportSenderEmail: String(row.report_sender_email ?? ""),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function clientFromRow(row: Row): Client {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    website: String(row.website ?? ""),
    ownerUserId: String(row.owner_user_id ?? ""),
    reportRecipientEmail: String(row.report_recipient_email ?? ""),
    reportCadence: (row.report_cadence as Client["reportCadence"]) ?? "monthly",
    notes: String(row.notes ?? ""),
    archivedAt: nullableTime(row.archived_at),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function workflowFromRow(row: Row): Workflow {
  const authConfig = jsonObject<{ headers?: Workflow["headers"] }>(row.encrypted_auth_config, {})
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    name: String(row.name ?? ""),
    type: (row.type as Workflow["type"]) ?? "http_endpoint",
    environment: (row.environment as Workflow["environment"]) ?? "production",
    endpointUrl: String(row.endpoint_url ?? ""),
    method: (row.method as Workflow["method"]) ?? "GET",
    headers: sanitizeStoredWorkflowHeaders(authConfig.headers),
    requestBody: String(row.request_body ?? ""),
    expectedStatus: Number(row.expected_status ?? 200),
    timeoutSeconds: Number(row.timeout_seconds ?? 10),
    maxLatencyMs: Number(row.max_latency_ms ?? 5000),
    frequencyMinutes: Number(row.frequency_minutes ?? 60),
    retries: Number(row.retries ?? 2),
    reportIncluded: Boolean(row.report_included),
    storeRawResponse: Boolean(row.store_raw_response),
    status: (row.status as Workflow["status"]) ?? "pending",
    healthScore: Number(row.health_score ?? 0),
    lastCheckRunAt: nullableTime(row.last_check_run_at),
    archivedAt: nullableTime(row.archived_at),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function checkFromRow(row: Row): Check {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    workflowId: String(row.workflow_id),
    name: String(row.name ?? ""),
    type: (row.type as Check["type"]) ?? "health",
    pluginId: String(row.plugin_id ?? "endpoint"),
    configJson: jsonObject<Record<string, unknown>>(row.config_json, {}),
    enabled: Boolean(row.enabled),
    pendingSetup: Boolean(row.pending_setup),
    scheduleMinutes: Number(row.schedule_minutes ?? 60),
    assertions: jsonArray<Check["assertions"][number]>(row.assertions_json),
    lastRunAt: nullableTime(row.last_run_at),
    nextRunAt: nullableTime(row.next_run_at),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function checkRunFromRow(row: Row): CheckRun {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    workflowId: String(row.workflow_id),
    checkId: String(row.check_id),
    evidenceOrigin: normalizeCheckRunEvidenceOrigin(row.evidence_origin),
    status: (row.status as CheckRun["status"]) ?? "failed",
    statusCode: typeof row.status_code === "number" ? row.status_code : null,
    latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : null,
    assertionResults: sanitizeAssertionResults(row.assertion_results_json),
    resultJson: {},
    safeResponseSummary: String(row.safe_response_summary ?? ""),
    errorMessage: String(row.error_message ?? ""),
    startedAt: rowTime(row.started_at),
    completedAt: rowTime(row.completed_at),
    createdAt: rowTime(row.created_at),
  }
}

function issueFromRow(row: Row): Issue {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    workflowId: String(row.workflow_id),
    checkRunId: String(row.check_run_id ?? ""),
    verificationRunId: typeof row.verification_run_id === "string" ? row.verification_run_id : null,
    checkId: String(row.check_id ?? ""),
    dedupeKey: String(row.dedupe_key ?? ""),
    severity: (row.severity as Issue["severity"]) ?? "medium",
    status: (row.status as Issue["status"]) ?? "open",
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    suggestedAction: String(row.suggested_action ?? ""),
    ownerUserId: String(row.owner_user_id ?? ""),
    reportable: Boolean(row.reportable),
    occurrenceCount: Number(row.occurrence_count ?? 1),
    snoozedUntil: nullableTime(row.snoozed_until),
    repairRecordedAt: nullableTime(row.repair_recorded_at),
    resolvedAt: nullableTime(row.resolved_at),
    resolutionNote: String(row.resolution_note ?? ""),
    reportSafeSummary: String(row.report_safe_summary ?? ""),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function reportItemFromRow(row: Row): ReportItem {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    reportId: String(row.report_id),
    clientId: String(row.client_id),
    sourceType: (row.source_type as ReportItem["sourceType"]) ?? "recommendation",
    sourceId: String(row.source_id ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    reportSafe: Boolean(row.report_safe),
    snapshotVersion: Number(row.snapshot_version ?? 0),
    createdAt: rowTime(row.created_at),
  }
}

function issueNoteFromRow(row: Row): IssueNote {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    issueId: String(row.issue_id),
    userId: String(row.user_id ?? ""),
    body: String(row.body ?? ""),
    reportSafe: Boolean(row.report_safe),
    createdAt: rowTime(row.created_at),
  }
}

function rowTime(value: unknown) {
  return typeof value === "string" ? canonicalTime(value) : new Date().toISOString()
}

function nullableTime(value: unknown) {
  return typeof value === "string" ? canonicalTime(value) : null
}

function canonicalTime(value: string) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value
}

function jsonObject<T extends object>(value: unknown, fallback: T): T {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback
}

function nullableJsonObject<T extends object>(value: unknown): T | null {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    ? (value as T)
    : null
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function snapshotEvidenceProjection(snapshot: NonNullable<Report["snapshot"]>) {
  return {
    ...snapshot,
    narrative: undefined,
    evidenceItems: snapshot.evidenceItems.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      title: item.title,
      body: item.body,
      reportSafe: item.reportSafe,
      createdAt: item.createdAt,
    })),
  }
}

function readinessProjection(readiness: Record<string, boolean>) {
  return Object.fromEntries(Object.entries(readiness).filter(([key]) => key !== "pdfGenerated"))
}

function stableSerialize(value: unknown) {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  )
}
