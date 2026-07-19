"use client"

import type { AuthUser } from "../auth-storage.ts"
import {
  addIssueNote,
  archiveClientRecord,
  createClientRecord,
  createPendingWorkflow,
  createReportDownload,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  generateReportRecord,
  recordScheduledCheckJob,
  recordIssueRepair,
  refreshReportRecord,
  runWorkflowCheck,
  updateAgency,
  updateClientRecord,
  updateIssueRecord,
  updateReportNarrative,
  type WorkflowSetupInput,
} from "../core/local-store.ts"
import type {
  Agency,
  AuditEvent,
  Check,
  CheckJobRun,
  CheckRun,
  Client,
  CoreDatabase,
  EndpointTestResult,
  Issue,
  IssueNote,
  Membership,
  Report,
  ReportItem,
  ReportSnapshot,
  Workflow,
} from "../core/types.ts"
import { normalizeReportStatus, reconcileReportStaleness } from "../core/report-state.ts"
import { sanitizeAssertionResults } from "../core/assertions.ts"
import {
  assertSafeSavedAssertions,
  assertSafeSavedCheckConfig,
  assertSavedMonitorPolicy,
} from "../core/saved-monitor-policy.ts"
import {
  normalizeCheckRunEvidenceOrigin,
  serviceIssuedAssuranceView,
} from "../core/evidence-provenance.ts"
import { sanitizeStoredWorkflowHeaders, storedWorkflowHeaders } from "../core/workflow-auth.ts"
import { getSupabaseAccessToken, getValidSupabaseAccessToken, verifySupabaseSession } from "./auth.ts"
import { getSupabaseConfig } from "./config.ts"
import type { LegacyCoreSyncRequest } from "../legacy/core-sync-contract.ts"

type Row = Record<string, unknown>

type TableName =
  | "agencies"
  | "memberships"
  | "clients"
  | "workflows"
  | "checks"
  | "check_runs"
  | "check_job_runs"
  | "issues"
  | "issue_notes"
  | "reports"
  | "report_items"
  | "audit_events"

function headers(token: string, prefer = "return=representation") {
  const config = getSupabaseConfig()
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: prefer,
  }
}

async function supabaseJson<T>(path: string, init: RequestInit = {}) {
  const config = getSupabaseConfig()
  const token = await getValidSupabaseAccessToken()
  if (!config.enabled || !token) {
    throw new Error("Supabase is not configured or the user is not signed in.")
  }

  let response = await fetch(`${config.restUrl}/${path}`, {
    ...init,
    headers: {
      ...headers(token),
      ...(init.headers ?? {}),
    },
  })
  if (response.status === 401) {
    await verifySupabaseSession()
    const refreshedToken = getSupabaseAccessToken()
    if (refreshedToken && refreshedToken !== token) {
      response = await fetch(`${config.restUrl}/${path}`, {
        ...init,
        headers: {
          ...headers(refreshedToken),
          ...(init.headers ?? {}),
        },
      })
    }
  }
  const payload = await response.text()
  const parsed = payload ? JSON.parse(payload) : null

  if (!response.ok) {
    const message =
      typeof parsed?.message === "string"
        ? parsed.message
        : typeof parsed?.hint === "string"
          ? parsed.hint
          : "Supabase request failed."
    throw new Error(message)
  }

  return parsed as T
}

async function legacyCoreSyncJson(agencyId: string, body: LegacyCoreSyncRequest) {
  const token = await getValidSupabaseAccessToken()
  if (!token) {
    throw new Error("The user is not signed in.")
  }

  const request = (accessToken: string) => fetch("/api/legacy-core-sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-MaintainFlow-Workspace-Id": agencyId,
    },
    body: JSON.stringify(body),
  })

  let response = await request(token)
  if (response.status === 401) {
    await verifySupabaseSession()
    const refreshedToken = getSupabaseAccessToken()
    if (refreshedToken && refreshedToken !== token) {
      response = await request(refreshedToken)
    }
  }
  const payload = await response.text()
  const parsed = payload ? JSON.parse(payload) : null
  if (!response.ok) {
    throw new Error(
      typeof parsed?.error?.message === "string"
        ? parsed.error.message
        : "Legacy workspace synchronization failed."
    )
  }
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function inList(values: string[]) {
  return `in.(${values.join(",")})`
}

function sortByCreatedAtDesc<T extends { createdAt?: string }>(items: T[]) {
  return [...items].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
}

function rowTime(value: unknown) {
  return typeof value === "string" ? value : new Date().toISOString()
}

function nullableTime(value: unknown) {
  return typeof value === "string" ? value : null
}

function jsonArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function jsonObject<T extends object>(value: unknown, fallback: T): T {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : fallback
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
    stripeSubscriptionStatus: (row.stripe_subscription_status as Agency["stripeSubscriptionStatus"]) ?? "",
    complimentaryEntitlement: Boolean(row.complimentary_entitlement),
    complimentaryEntitlementReason: String(row.complimentary_entitlement_reason ?? ""),
    reportSenderName: String(row.report_sender_name ?? ""),
    reportSenderEmail: String(row.report_sender_email ?? ""),
    createdAt: rowTime(row.created_at),
    updatedAt: rowTime(row.updated_at),
  }
}

function membershipFromRow(row: Row): Membership {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    userId: String(row.user_id),
    role: (row.role as Membership["role"]) ?? "member",
    createdAt: rowTime(row.created_at),
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
    assertions: jsonArray(row.assertions_json),
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

function checkJobRunFromRow(row: Row): CheckJobRun {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    status: (row.status as CheckJobRun["status"]) ?? "failed",
    checksDue: Number(row.checks_due ?? 0),
    checksRun: Number(row.checks_run ?? 0),
    failures: Number(row.failures ?? 0),
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

function reportFromRow(row: Row): Report {
  const snapshotVersion = Number(row.snapshot_version ?? 0)
  const snapshot = snapshotVersion > 0 && row.snapshot_json && typeof row.snapshot_json === "object" && !Array.isArray(row.snapshot_json)
    ? (row.snapshot_json as ReportSnapshot)
    : null
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    periodStart: String(row.period_start ?? ""),
    periodEnd: String(row.period_end ?? ""),
    status: normalizeReportStatus(row.status),
    narrative: String(row.narrative ?? ""),
    readiness: jsonObject(row.readiness_json, {}),
    metrics: jsonObject(row.metrics_json, {
      workflowsMonitored: 0,
      checksRun: 0,
      passRate: 0,
      issuesDetected: 0,
      issuesResolved: 0,
      unresolvedHighRiskIssues: 0,
      averageLatencyMs: null,
    }),
    snapshotVersion,
    snapshot,
    evidenceFingerprint: String(row.evidence_fingerprint ?? snapshot?.evidenceFingerprint ?? ""),
    staleAt: nullableTime(row.stale_at),
    pdfDataUrl: null,
    pdfStoragePath: typeof row.pdf_storage_path === "string" ? row.pdf_storage_path : null,
    pdfSnapshotVersion: typeof row.pdf_snapshot_version === "number" ? row.pdf_snapshot_version : null,
    sentAt: nullableTime(row.sent_at),
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

function auditEventFromRow(row: Row): AuditEvent {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    actorUserId: String(row.actor_user_id ?? ""),
    entityType: String(row.entity_type ?? ""),
    entityId: String(row.entity_id ?? ""),
    action: String(row.action ?? ""),
    metadata: jsonObject(row.metadata_json, {}),
    createdAt: rowTime(row.created_at),
  }
}

function agencyUpdateToRow(item: Agency): Row {
  return {
    name: item.name,
    slug: item.slug,
    report_sender_name: item.reportSenderName,
    report_sender_email: item.reportSenderEmail || null,
    updated_at: item.updatedAt,
  }
}

function clientToRow(item: Client): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    name: item.name,
    slug: item.slug,
    website: item.website,
    owner_user_id: item.ownerUserId || null,
    report_recipient_email: item.reportRecipientEmail || null,
    report_cadence: item.reportCadence,
    notes: item.notes,
    archived_at: item.archivedAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }
}

function workflowToRow(item: Workflow): Row {
  if (item.storeRawResponse) {
    throw new Error("Raw response storage is disabled for saved monitors.")
  }
  const savedMonitor = assertSavedMonitorPolicy({
    endpointUrl: item.endpointUrl,
    method: item.method,
    headers: Object.fromEntries(item.headers.map((header) => [header.key, header.valuePreview])),
    requestBody: item.requestBody,
  }, { allowEmptyEndpoint: true })
  return {
    id: item.id,
    agency_id: item.agencyId,
    client_id: item.clientId,
    name: item.name,
    type: item.type,
    environment: item.environment,
    endpoint_url: savedMonitor.endpointUrl,
    method: savedMonitor.method,
    auth_type: "none",
    encrypted_auth_config: { headers: storedWorkflowHeaders(savedMonitor.headers) },
    request_body: savedMonitor.requestBody,
    expected_status: item.expectedStatus,
    timeout_seconds: item.timeoutSeconds,
    max_latency_ms: item.maxLatencyMs,
    frequency_minutes: item.frequencyMinutes,
    retries: item.retries,
    report_included: item.reportIncluded,
    store_raw_response: false,
    status: item.status,
    health_score: item.healthScore,
    last_check_run_at: item.lastCheckRunAt,
    archived_at: item.archivedAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }
}

function checkToRow(item: Check): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    workflow_id: item.workflowId,
    name: item.name,
    type: item.type,
    plugin_id: item.pluginId || "endpoint",
    config_json: assertSafeSavedCheckConfig(item.configJson || {}),
    enabled: item.enabled,
    pending_setup: item.pendingSetup,
    assertions_json: assertSafeSavedAssertions(item.assertions),
    schedule_minutes: item.scheduleMinutes,
    last_run_at: item.lastRunAt,
    next_run_at: item.nextRunAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }
}

function checkRunToRow(item: CheckRun): Row {
  // Never send evidence_origin from the browser. Expansion keeps this legacy
  // write path compatible, but PostgreSQL must apply its untrusted default.
  return {
    id: item.id,
    agency_id: item.agencyId,
    client_id: item.clientId,
    workflow_id: item.workflowId,
    check_id: item.checkId,
    status: item.status,
    status_code: item.statusCode,
    latency_ms: item.latencyMs,
    assertion_results_json: sanitizeAssertionResults(item.assertionResults),
    result_json: {},
    safe_response_summary: item.safeResponseSummary,
    error_message: item.errorMessage,
    started_at: item.startedAt,
    completed_at: item.completedAt,
    created_at: item.createdAt,
  }
}

function checkJobRunToRow(item: CheckJobRun): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    status: item.status,
    checks_due: item.checksDue,
    checks_run: item.checksRun,
    failures: item.failures,
    error_message: item.errorMessage,
    started_at: item.startedAt,
    completed_at: item.completedAt,
    created_at: item.createdAt,
  }
}

function issueToRow(item: Issue): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    client_id: item.clientId,
    workflow_id: item.workflowId,
    check_run_id: item.checkRunId || null,
    verification_run_id: item.verificationRunId,
    check_id: item.checkId || null,
    dedupe_key: item.dedupeKey,
    severity: item.severity,
    status: item.status,
    title: item.title,
    description: item.description,
    suggested_action: item.suggestedAction,
    owner_user_id: item.ownerUserId || null,
    reportable: item.reportable,
    occurrence_count: item.occurrenceCount,
    snoozed_until: item.snoozedUntil,
    repair_recorded_at: item.repairRecordedAt,
    resolved_at: item.resolvedAt,
    resolution_note: item.resolutionNote,
    report_safe_summary: item.reportSafeSummary,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }
}

function issueNoteToRow(item: IssueNote): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    issue_id: item.issueId,
    user_id: item.userId || null,
    body: item.body,
    report_safe: item.reportSafe,
    created_at: item.createdAt,
  }
}

function reportToRow(item: Report): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    client_id: item.clientId,
    period_start: item.periodStart,
    period_end: item.periodEnd,
    status: item.status,
    narrative: item.narrative,
    readiness_json: item.readiness,
    metrics_json: item.metrics,
    snapshot_version: item.snapshotVersion,
    snapshot_json: item.snapshot ?? {},
    evidence_fingerprint: item.evidenceFingerprint,
    stale_at: item.staleAt,
    pdf_storage_path: item.pdfStoragePath,
    pdf_snapshot_version: item.pdfSnapshotVersion,
    sent_at: item.sentAt,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }
}

function reportItemToRow(item: ReportItem): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    report_id: item.reportId,
    client_id: item.clientId,
    source_type: item.sourceType,
    source_id: item.sourceId,
    title: item.title,
    body: item.body,
    report_safe: item.reportSafe,
    snapshot_version: item.snapshotVersion,
    created_at: item.createdAt,
  }
}

function auditEventToRow(item: AuditEvent): Row {
  return {
    id: item.id,
    agency_id: item.agencyId,
    actor_user_id: item.actorUserId || null,
    entity_type: item.entityType,
    entity_id: item.entityId || null,
    action: item.action,
    metadata_json: item.metadata,
    created_at: item.createdAt,
  }
}

async function insertRowsIgnoringDuplicates(table: TableName, rows: Row[]) {
  if (rows.length === 0) return
  await supabaseJson(`${table}?on_conflict=id`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  })
}

export async function loadCoreDatabaseFromSupabase(userId: string): Promise<CoreDatabase> {
  const memberships = (await supabaseJson<Row[]>(`memberships?${query({ select: "*", user_id: `eq.${userId}` })}`)).map(membershipFromRow)
  const agencyIds = memberships.map((membership) => membership.agencyId)

  if (agencyIds.length === 0) {
    return emptyCoreDatabase()
  }

  const agencyFilter = inList(agencyIds)
  const [
    agencies,
    clients,
    workflows,
    checks,
    checkRuns,
    checkJobRuns,
    issues,
    issueNotes,
    reports,
    reportItems,
    auditEvents,
  ] = await Promise.all([
    supabaseJson<Row[]>(`agencies?${query({ select: "*", id: agencyFilter })}`),
    supabaseJson<Row[]>(`clients?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`workflows?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`checks?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`check_runs?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`check_job_runs?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`issues?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`issue_notes?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`reports?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`report_items?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
    supabaseJson<Row[]>(`audit_events?${query({ select: "*", agency_id: agencyFilter, order: "created_at.desc" })}`),
  ])

  return reconcileReportStaleness(serviceIssuedAssuranceView({
    agencies: agencies.map(agencyFromRow),
    memberships,
    clients: clients.map(clientFromRow),
    workflows: workflows.map(workflowFromRow),
    checks: checks.map(checkFromRow),
    checkRuns: checkRuns.map(checkRunFromRow),
    checkJobRuns: checkJobRuns.map(checkJobRunFromRow),
    issues: issues.map(issueFromRow),
    issueNotes: issueNotes.map(issueNoteFromRow),
    reports: reports.map(reportFromRow),
    reportItems: reportItems.map(reportItemFromRow),
    auditEvents: auditEvents.map(auditEventFromRow),
  }))
}

export async function createAgencyWorkspaceInSupabase(user: AuthUser, input: { name: string; slug: string }) {
  const rows = await supabaseJson<Row[]>("rpc/create_agency_workspace", {
    method: "POST",
    body: JSON.stringify({
      agency_name: input.name,
      agency_slug: input.slug,
      sender_name: user.name,
      sender_email: user.email,
    }),
  })
  const agency = agencyFromRow(Array.isArray(rows) ? rows[0] : (rows as Row))
  return loadCoreDatabaseFromSupabase(user.id).then((database) => ({
    ...database,
    agencies: database.agencies.some((item) => item.id === agency.id) ? database.agencies : [agency, ...database.agencies],
  }))
}

export async function updateAgencyInSupabase(agency: Agency, expectedUpdatedAt = agency.updatedAt) {
  const rows = await supabaseJson<Row[]>(`agencies?${query({
    id: `eq.${agency.id}`,
    updated_at: `eq.${expectedUpdatedAt}`,
    select: "id",
  })}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(agencyUpdateToRow(agency)),
  })
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("Agency changed in another session. Reload and try again.")
  }
}

export async function syncCoreDatabaseToSupabase(
  database: CoreDatabase,
  agencyIds: string[],
  previousDatabase: CoreDatabase = emptyCoreDatabase()
) {
  const keep = new Set(agencyIds)

  await syncLegacyCoreRows("clients", previousDatabase.clients, database.clients, keep, clientToRow)
  await syncLegacyCoreRows("workflows", previousDatabase.workflows, database.workflows, keep, workflowToRow)
  await syncMutableRows("checks", previousDatabase.checks, database.checks, keep, checkToRow)
  await insertNewRows("check_runs", previousDatabase.checkRuns, database.checkRuns, keep, checkRunToRow)
  await insertNewRows("check_job_runs", previousDatabase.checkJobRuns, database.checkJobRuns, keep, checkJobRunToRow)
  await syncMutableRows("issues", previousDatabase.issues, database.issues, keep, issueToRow)
  await insertNewRows("issue_notes", previousDatabase.issueNotes, database.issueNotes, keep, issueNoteToRow)
  await syncMutableRows("reports", previousDatabase.reports, database.reports, keep, reportToRow)
  await insertNewRows("report_items", previousDatabase.reportItems, database.reportItems, keep, reportItemToRow)
  await insertNewRows("audit_events", previousDatabase.auditEvents, database.auditEvents, keep, auditEventToRow)
}

type SyncRecord = { id: string; agencyId: string; updatedAt?: string }

async function syncLegacyCoreRows<T extends SyncRecord>(
  table: "clients" | "workflows",
  previousItems: T[],
  nextItems: T[],
  keep: Set<string>,
  toRow: (item: T) => Row
) {
  const previousById = new Map(previousItems.map((item) => [item.id, item]))
  const changed = nextItems.filter((item) => {
    if (!keep.has(item.agencyId)) return false
    const previous = previousById.get(item.id)
    return !previous || JSON.stringify(previous) !== JSON.stringify(item)
  })

  for (const agencyId of keep) {
    const workspaceRows = changed.filter((item) => item.agencyId === agencyId)
    if (!workspaceRows.length) continue
    const creates = workspaceRows
      .filter((item) => !previousById.has(item.id))
      .map(toRow)
    const updates = workspaceRows
      .filter((item) => previousById.has(item.id))
      .map((item) => {
        const expectedUpdatedAt = previousById.get(item.id)?.updatedAt
        if (!expectedUpdatedAt) {
          throw new Error(`${table} changed without a concurrency timestamp. Reload and try again.`)
        }
        return { expectedUpdatedAt, row: toRow(item) }
      })

    await legacyCoreSyncJson(agencyId, {
      table,
      creates,
      updates,
    } as LegacyCoreSyncRequest)
  }
}

async function syncMutableRows<T extends SyncRecord>(
  table: TableName,
  previousItems: T[],
  nextItems: T[],
  keep: Set<string>,
  toRow: (item: T) => Row
) {
  const previousById = new Map(previousItems.map((item) => [item.id, item]))
  const changed = nextItems.filter((item) => {
    if (!keep.has(item.agencyId)) return false
    const previous = previousById.get(item.id)
    return !previous || JSON.stringify(previous) !== JSON.stringify(item)
  })
  await insertRowsIgnoringDuplicates(
    table,
    changed.filter((item) => !previousById.has(item.id)).map(toRow)
  )

  for (const item of changed.filter((candidate) => previousById.has(candidate.id))) {
    const previous = previousById.get(item.id)
    if (!previous?.updatedAt) {
      throw new Error(`${table} changed without a concurrency timestamp. Reload and try again.`)
    }
    const rows = await supabaseJson<Row[]>(`${table}?${query({
      id: `eq.${item.id}`,
      agency_id: `eq.${item.agencyId}`,
      updated_at: `eq.${previous.updatedAt}`,
      select: "id",
    })}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toRow(item)),
    })
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(`${table} changed in another session. Reload and try again.`)
    }
  }
}

async function insertNewRows<T extends SyncRecord>(
  table: TableName,
  previousItems: T[],
  nextItems: T[],
  keep: Set<string>,
  toRow: (item: T) => Row
) {
  const existingIds = new Set(previousItems.map((item) => item.id))
  await insertRowsIgnoringDuplicates(
    table,
    nextItems.filter((item) => keep.has(item.agencyId) && !existingIds.has(item.id)).map(toRow)
  )
}

export const supabaseLocalActions = {
  addIssueNote,
  archiveClientRecord,
  createClientRecord,
  createPendingWorkflow,
  createReportDownload,
  createWorkflowWithFirstRun,
  generateReportRecord,
  recordScheduledCheckJob,
  recordIssueRepair,
  refreshReportRecord,
  runWorkflowCheck,
  updateAgency,
  updateClientRecord,
  updateIssueRecord,
  updateReportNarrative,
  updateAgencyInSupabase,
  sortByCreatedAtDesc,
  syncCoreDatabaseToSupabase,
}

export type { WorkflowSetupInput, EndpointTestResult }
