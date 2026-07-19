import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

import { currentMonthToDate } from "../src/lib/core/report-period.ts"
import { buildReportSnapshot } from "../src/lib/core/report-state.ts"

const env = {
  ...readEnvFile(process.env.MAINTAINFLOW_ENV_FILE || ".env.local"),
  ...process.env,
}

const supabaseUrl = requiredBaseUrl("NEXT_PUBLIC_SUPABASE_URL")
const authUrl = (env.NEXT_PUBLIC_SUPABASE_AUTH_URL || supabaseUrl).replace(/\/+$/, "")
const anonKey = requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY")
const appUrl = (env.SMOKE_APP_URL || env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "")
const monitorUrl = publicMonitorUrl(env.SMOKE_MONITOR_URL || env.NEXT_PUBLIC_APP_URL || appUrl)
const expectServiceOnlyEvidence = env.EXPECT_SERVICE_ONLY_EVIDENCE !== "false"

const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
const password = `MaintainFlowSmoke-${randomUUID()}!`
const email = `maintainflow-assurance-smoke+${runId}@maintainflow.io`
const ids = {
  clientId: randomUUID(),
  workflowId: randomUUID(),
  checkId: randomUUID(),
  failureRunId: "",
  verificationRunId: "",
  issueId: "",
  repairNoteId: randomUUID(),
  reportId: randomUUID(),
}

let userId = ""
let agencyId = ""
let pdfStoragePath = ""
const evidence = []

try {
  const adminUser = await createConfirmedUser(email, password)
  userId = adminUser.id
  evidence.push("created an isolated confirmed Supabase QA user")

  const session = await signInWithPassword(email, password)
  const token = session.access_token
  evidence.push("signed in through production Supabase email/password auth")

  const agency = await createWorkspace(token)
  agencyId = agency.id
  evidence.push("created a self-serve Free workspace through the authenticated RPC")

  await insertAssuranceSetupRecords(token, agency)
  evidence.push("saved a client journey and enabled check without browser-issued run evidence")

  const forgedRunId = randomUUID()
  const forgedRunResponse = await restFetch("/check_runs", {
    method: "POST",
    token,
    body: legacyRunPayload(forgedRunId, { evidence_origin: "service" }),
  })
  if (forgedRunResponse.ok) {
    throw new Error("Authenticated browser credentials were able to stamp service-issued evidence.")
  }
  evidence.push("verified authenticated browser credentials cannot stamp service provenance")

  const legacyRunId = randomUUID()
  const legacyRunResponse = await restFetch("/check_runs", {
    method: "POST",
    token,
    body: legacyRunPayload(legacyRunId),
  })
  if (expectServiceOnlyEvidence) {
    if (legacyRunResponse.ok) {
      throw new Error("Authenticated browser credentials were able to create legacy check evidence in contract mode.")
    }
    evidence.push("verified authenticated browser credentials cannot create any check evidence")
  } else {
    if (!legacyRunResponse.ok) {
      throw new Error(`The expansion-compatible browser insert was rejected: ${errorMessage(await json(legacyRunResponse))}`)
    }
    const legacyRun = await selectOne(token, `/check_runs?id=eq.${legacyRunId}&agency_id=eq.${agencyId}&limit=1`)
    if (legacyRun?.evidence_origin !== "legacy_browser") {
      throw new Error("The expansion-compatible browser insert was not marked as untrusted legacy evidence.")
    }
    const forgedUpdate = await restFetch(`/check_runs?id=eq.${legacyRunId}&agency_id=eq.${agencyId}`, {
      method: "PATCH",
      token,
      body: { evidence_origin: "service" },
    })
    if (forgedUpdate.ok) {
      throw new Error("Authenticated browser credentials promoted legacy evidence to service provenance.")
    }
    await restFetch(`/check_runs?id=eq.${legacyRunId}&agency_id=eq.${agencyId}`, {
      method: "DELETE",
      token,
      prefer: "return=minimal",
    })
    evidence.push("verified the expand-era legacy write stays compatible, untrusted, and non-promotable")
  }

  const failureResult = await callAppJson("/api/checks/test", {
    method: "POST",
    token,
    body: { checkId: ids.checkId },
  })
  if (!["degraded", "failed"].includes(failureResult.status) || !failureResult.persisted || !failureResult.runId) {
    throw new Error(`Server-issued nonhealthy evidence was not confirmed: ${failureResult.status || "unknown"}.`)
  }
  ids.failureRunId = failureResult.runId
  const tamperedServiceRun = await restFetch(`/check_runs?id=eq.${ids.failureRunId}&agency_id=eq.${agencyId}`, {
    method: "PATCH",
    token,
    body: { status: "healthy" },
  })
  if (tamperedServiceRun.ok) {
    throw new Error("Authenticated browser credentials mutated service-issued evidence.")
  }
  evidence.push("recorded a nonhealthy real-network journey through the server-issued atomic evidence API")
  evidence.push("verified service-issued evidence is immutable to browser credentials")

  const openIssue = await selectOne(token, `/issues?agency_id=eq.${agencyId}&check_id=eq.${ids.checkId}&status=eq.open&limit=1`)
  if (!openIssue?.id || openIssue.check_run_id !== ids.failureRunId) {
    throw new Error("The failed server run did not create its linked issue.")
  }
  ids.issueId = openIssue.id
  const repairRecordedAt = new Date(Date.now() - 1_000).toISOString()
  const repairNote = "The journey was repaired and is ready for a newer server verification run."
  await updateRows(token, "issues", `id=eq.${ids.issueId}&agency_id=eq.${agencyId}`, {
    status: "in_review",
    repair_recorded_at: repairRecordedAt,
    resolved_at: null,
    verification_run_id: null,
    resolution_note: repairNote,
    report_safe_summary: repairNote,
    snoozed_until: null,
    updated_at: new Date().toISOString(),
  })
  await insertRows(token, "issue_notes", [{
    id: ids.repairNoteId,
    agency_id: agencyId,
    issue_id: ids.issueId,
    user_id: userId,
    body: repairNote,
    report_safe: true,
    created_at: repairRecordedAt,
  }])
  await updateRows(token, "checks", `id=eq.${ids.checkId}&agency_id=eq.${agencyId}`, {
    config_json: endpointConfig(200),
    updated_at: new Date().toISOString(),
  })

  const verificationResult = await callAppJson("/api/checks/test", {
    method: "POST",
    token,
    body: { checkId: ids.checkId },
  })
  if (verificationResult.status !== "healthy" || !verificationResult.persisted || !verificationResult.runId) {
    throw new Error(`Server-issued verification evidence was not confirmed: ${verificationResult.status || "unknown"}.`)
  }
  ids.verificationRunId = verificationResult.runId
  const resolvedIssue = await selectOne(token, `/issues?id=eq.${ids.issueId}&agency_id=eq.${agencyId}&limit=1`)
  if (resolvedIssue?.status !== "resolved" || resolvedIssue.verification_run_id !== ids.verificationRunId) {
    throw new Error("The newer healthy run did not atomically verify the repair.")
  }
  evidence.push("verified repair resolution with a newer healthy server run")

  await insertCanonicalReport(token)
  evidence.push("built and stored a canonical current month-to-date report from server-issued evidence")

  const prepared = await callAppJson(`/api/reports/${ids.reportId}/prepare`, { method: "POST", token })
  pdfStoragePath = prepared.pdfStoragePath || ""
  const expectedPath = `${agencyId}/reports/${ids.reportId}/snapshot-1.pdf`
  if (pdfStoragePath !== expectedPath) {
    throw new Error(`Report prepare route returned an unexpected snapshot path: ${pdfStoragePath || "none"}.`)
  }
  evidence.push("generated an immutable snapshot-bound private report PDF")

  const pdf = await callApp(`/api/reports/${ids.reportId}/download`, { method: "GET", token })
  const pdfBytes = Buffer.from(await pdf.arrayBuffer())
  if (!pdf.ok || pdfBytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error(`Report download did not return a PDF. HTTP ${pdf.status}.`)
  }
  evidence.push("downloaded the authorized private report PDF")

  const unauthPdf = await callApp(`/api/reports/${ids.reportId}/download`, { method: "GET" })
  if (unauthPdf.status !== 401) {
    throw new Error(`Unauthenticated report download returned ${unauthPdf.status}, expected 401.`)
  }
  evidence.push("verified private report download rejects unauthenticated access")

  console.log("Maintain Flow production assurance smoke passed.")
  console.log(`App URL: ${appUrl}`)
  for (const item of evidence) {
    console.log(`OK    ${item}`)
  }
} finally {
  await cleanup().catch((error) => {
    console.error(`Cleanup warning: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function createConfirmedUser(userEmail, userPassword) {
  const response = await authFetch("/auth/v1/admin/users", {
    method: "POST",
    service: true,
    body: {
      email: userEmail,
      password: userPassword,
      email_confirm: true,
      user_metadata: { name: "Maintain Flow Assurance Smoke" },
    },
  })
  const payload = await json(response)
  if (!response.ok || !payload.id) {
    throw new Error(`Could not create Supabase QA user: ${errorMessage(payload)}`)
  }
  return payload
}

async function signInWithPassword(userEmail, userPassword) {
  const response = await authFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: userEmail, password: userPassword },
  })
  const payload = await json(response)
  if (!response.ok || !payload.access_token || !payload.user?.id) {
    throw new Error(`Could not sign in Supabase QA user: ${errorMessage(payload)}`)
  }
  return payload
}

async function createWorkspace(token) {
  const response = await restFetch("/rpc/create_agency_workspace", {
    method: "POST",
    token,
    body: {
      agency_name: `Maintain Flow Assurance Smoke ${runId}`,
      agency_slug: `maintain-flow-assurance-smoke-${runId}`,
      sender_name: "Maintain Flow Smoke",
      sender_email: email,
    },
  })
  const payload = await json(response)
  const agency = Array.isArray(payload) ? payload[0] : payload
  if (!response.ok || !agency?.id) {
    throw new Error(`Could not create smoke workspace: ${errorMessage(payload)}`)
  }
  return agency
}

async function insertAssuranceSetupRecords(token) {
  const createdAt = new Date().toISOString()
  const client = {
    id: ids.clientId,
    agencyId,
    name: "Assurance Smoke Client",
    slug: `assurance-smoke-client-${runId}`,
    website: monitorUrl,
    ownerUserId: userId,
    reportRecipientEmail: email,
    reportCadence: "monthly",
    notes: "Temporary production assurance smoke client.",
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  }
  const workflow = {
    id: ids.workflowId,
    agencyId,
    clientId: ids.clientId,
    name: "Maintain Flow production journey health",
    type: "http_endpoint",
    environment: "production",
    endpointUrl: monitorUrl,
    method: "GET",
    headers: [],
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 5,
    maxLatencyMs: 5000,
    frequencyMinutes: 60,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    status: "pending",
    healthScore: 0,
    lastCheckRunAt: null,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  }

  await insertRows(token, "clients", [clientRow(client)])
  await insertRows(token, "workflows", [workflowRow(workflow)])
  await insertRows(token, "checks", [checkRow(workflow, createdAt)])
}

async function insertCanonicalReport(token) {
  const [agencyRow, clientDatabaseRow, workflowDatabaseRow, checkDatabaseRow, checkRunRows, issueRows, issueNoteRows] = await Promise.all([
    selectOne(token, `/agencies?id=eq.${agencyId}&limit=1`),
    selectOne(token, `/clients?id=eq.${ids.clientId}&agency_id=eq.${agencyId}&limit=1`),
    selectOne(token, `/workflows?id=eq.${ids.workflowId}&agency_id=eq.${agencyId}&limit=1`),
    selectOne(token, `/checks?id=eq.${ids.checkId}&agency_id=eq.${agencyId}&limit=1`),
    selectRows(token, `/check_runs?agency_id=eq.${agencyId}&check_id=eq.${ids.checkId}&evidence_origin=eq.service&order=created_at.desc`),
    selectRows(token, `/issues?agency_id=eq.${agencyId}&check_id=eq.${ids.checkId}&order=created_at.desc`),
    selectRows(token, `/issue_notes?agency_id=eq.${agencyId}&issue_id=eq.${ids.issueId}&report_safe=eq.true&order=created_at.asc`),
  ])
  if (!agencyRow || !clientDatabaseRow || !workflowDatabaseRow || !checkDatabaseRow || checkRunRows.length !== 2 || issueRows.length !== 1) {
    throw new Error("Could not reload the complete server-issued assurance evidence for reporting.")
  }

  const generatedAt = new Date().toISOString()
  const period = currentMonthToDate(new Date(generatedAt))
  const agency = {
    id: agencyId,
    name: String(agencyRow.name || `Maintain Flow Assurance Smoke ${runId}`),
    slug: String(agencyRow.slug || `maintain-flow-assurance-smoke-${runId}`),
    plan: String(agencyRow.plan || "free"),
    trialEndsAt: nullableTimestamp(agencyRow.trial_ends_at),
    stripeCustomerId: String(agencyRow.stripe_customer_id || ""),
    stripeSubscriptionId: String(agencyRow.stripe_subscription_id || ""),
    stripeSubscriptionStatus: String(agencyRow.stripe_subscription_status || ""),
    complimentaryEntitlement: Boolean(agencyRow.complimentary_entitlement),
    complimentaryEntitlementReason: String(agencyRow.complimentary_entitlement_reason || ""),
    reportSenderName: String(agencyRow.report_sender_name || "Maintain Flow Smoke"),
    reportSenderEmail: String(agencyRow.report_sender_email || email),
    createdAt: requiredTimestamp(agencyRow.created_at),
    updatedAt: requiredTimestamp(agencyRow.updated_at),
  }
  const client = clientFromRow(clientDatabaseRow)
  const workflow = workflowFromRow(workflowDatabaseRow)
  const check = checkFromRow(checkDatabaseRow)
  const checkRuns = checkRunRows.map(checkRunFromRow)
  const issues = issueRows.map(issueFromRow)
  const issueNotes = issueNoteRows.map(issueNoteFromRow)
  const built = buildReportSnapshot({
    agency,
    client,
    reportId: ids.reportId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    version: 1,
    generatedAt,
    workflows: [workflow],
    checks: [check],
    checkRuns,
    issues,
    issueNotes,
  })
  if (built.status !== "ready") {
    throw new Error(`Canonical smoke report was ${built.status}, expected ready.`)
  }
  await insertRows(token, "reports", [{
    id: ids.reportId,
    agency_id: agencyId,
    client_id: ids.clientId,
    period_start: period.periodStart,
    period_end: period.periodEnd,
    status: built.status,
    narrative: built.snapshot.narrative,
    readiness_json: built.readiness,
    metrics_json: built.snapshot.metrics,
    snapshot_version: 1,
    snapshot_json: built.snapshot,
    evidence_fingerprint: built.snapshot.evidenceFingerprint,
    stale_at: null,
    pdf_storage_path: null,
    pdf_snapshot_version: null,
    sent_at: null,
    created_at: generatedAt,
    updated_at: generatedAt,
  }])
  await insertRows(token, "report_items", built.reportItems.map((item) => ({
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
  })))
}

function clientRow(client) {
  return {
    id: client.id,
    agency_id: client.agencyId,
    name: client.name,
    slug: client.slug,
    website: client.website,
    owner_user_id: client.ownerUserId,
    report_recipient_email: client.reportRecipientEmail,
    report_cadence: client.reportCadence,
    notes: client.notes,
    archived_at: null,
    created_at: client.createdAt,
    updated_at: client.updatedAt,
  }
}

function workflowRow(workflow) {
  return {
    id: workflow.id,
    agency_id: workflow.agencyId,
    client_id: workflow.clientId,
    name: workflow.name,
    type: workflow.type,
    environment: workflow.environment,
    endpoint_url: workflow.endpointUrl,
    method: workflow.method,
    encrypted_auth_config: { headers: [] },
    request_body: workflow.requestBody,
    expected_status: workflow.expectedStatus,
    timeout_seconds: workflow.timeoutSeconds,
    max_latency_ms: workflow.maxLatencyMs,
    frequency_minutes: workflow.frequencyMinutes,
    retries: workflow.retries,
    report_included: workflow.reportIncluded,
    store_raw_response: workflow.storeRawResponse,
    status: workflow.status,
    health_score: workflow.healthScore,
    last_check_run_at: workflow.lastCheckRunAt,
    archived_at: null,
    created_at: workflow.createdAt,
    updated_at: workflow.updatedAt,
  }
}

function checkRow(workflow, createdAt) {
  return {
    id: ids.checkId,
    agency_id: agencyId,
    workflow_id: workflow.id,
    name: "Default journey health check",
    type: "health",
    plugin_id: "endpoint",
    config_json: endpointConfig(503),
    enabled: true,
    pending_setup: false,
    schedule_minutes: 60,
    assertions_json: [{ id: "response_exists", type: "response_exists", enabled: true }],
    last_run_at: null,
    next_run_at: new Date(new Date(createdAt).getTime() + 5 * 60_000).toISOString(),
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function endpointConfig(expectedStatus) {
  return {
    expectedStatus,
    timeoutSeconds: 5,
    maxLatencyMs: 5000,
  }
}

function legacyRunPayload(id, overrides = {}) {
  const now = new Date().toISOString()
  return {
    id,
    agency_id: agencyId,
    client_id: ids.clientId,
    workflow_id: ids.workflowId,
    check_id: ids.checkId,
    status: "healthy",
    status_code: 200,
    latency_ms: 1,
    assertion_results_json: [],
    result_json: {},
    safe_response_summary: "Expansion compatibility evidence is untrusted.",
    error_message: "",
    started_at: now,
    completed_at: now,
    created_at: now,
    ...overrides,
  }
}

function clientFromRow(row) {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    name: String(row.name || ""),
    slug: String(row.slug || ""),
    website: String(row.website || ""),
    ownerUserId: String(row.owner_user_id || ""),
    reportRecipientEmail: String(row.report_recipient_email || ""),
    reportCadence: String(row.report_cadence || "monthly"),
    notes: String(row.notes || ""),
    archivedAt: nullableTimestamp(row.archived_at),
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  }
}

function workflowFromRow(row) {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    name: String(row.name || ""),
    type: String(row.type || "http_endpoint"),
    environment: String(row.environment || "production"),
    endpointUrl: String(row.endpoint_url || ""),
    method: String(row.method || "GET"),
    headers: [],
    requestBody: String(row.request_body || ""),
    expectedStatus: Number(row.expected_status || 200),
    timeoutSeconds: Number(row.timeout_seconds || 10),
    maxLatencyMs: Number(row.max_latency_ms || 5000),
    frequencyMinutes: Number(row.frequency_minutes || 60),
    retries: Number(row.retries || 2),
    reportIncluded: Boolean(row.report_included),
    storeRawResponse: false,
    status: String(row.status || "pending"),
    healthScore: Number(row.health_score || 0),
    lastCheckRunAt: nullableTimestamp(row.last_check_run_at),
    archivedAt: nullableTimestamp(row.archived_at),
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  }
}

function checkFromRow(row) {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    workflowId: String(row.workflow_id),
    name: String(row.name || ""),
    type: String(row.type || "health"),
    pluginId: String(row.plugin_id || "endpoint"),
    configJson: row.config_json && typeof row.config_json === "object" ? row.config_json : {},
    enabled: Boolean(row.enabled),
    pendingSetup: Boolean(row.pending_setup),
    scheduleMinutes: Number(row.schedule_minutes || 60),
    assertions: Array.isArray(row.assertions_json) ? row.assertions_json : [],
    lastRunAt: nullableTimestamp(row.last_run_at),
    nextRunAt: nullableTimestamp(row.next_run_at),
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  }
}

function checkRunFromRow(row) {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    workflowId: String(row.workflow_id),
    checkId: String(row.check_id),
    evidenceOrigin: row.evidence_origin === "service" ? "service" : "legacy_browser",
    status: String(row.status),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    assertionResults: Array.isArray(row.assertion_results_json) ? row.assertion_results_json : [],
    resultJson: {},
    safeResponseSummary: String(row.safe_response_summary || ""),
    errorMessage: String(row.error_message || ""),
    startedAt: requiredTimestamp(row.started_at),
    completedAt: requiredTimestamp(row.completed_at),
    createdAt: requiredTimestamp(row.created_at),
  }
}

function issueFromRow(row) {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    clientId: String(row.client_id),
    workflowId: String(row.workflow_id),
    checkRunId: String(row.check_run_id || ""),
    verificationRunId: row.verification_run_id ? String(row.verification_run_id) : null,
    checkId: String(row.check_id || ""),
    dedupeKey: String(row.dedupe_key || ""),
    severity: String(row.severity || "medium"),
    status: String(row.status || "open"),
    title: String(row.title || ""),
    description: String(row.description || ""),
    suggestedAction: String(row.suggested_action || ""),
    ownerUserId: String(row.owner_user_id || ""),
    reportable: Boolean(row.reportable),
    occurrenceCount: Number(row.occurrence_count || 1),
    snoozedUntil: nullableTimestamp(row.snoozed_until),
    repairRecordedAt: nullableTimestamp(row.repair_recorded_at),
    resolvedAt: nullableTimestamp(row.resolved_at),
    resolutionNote: String(row.resolution_note || ""),
    reportSafeSummary: String(row.report_safe_summary || ""),
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  }
}

function issueNoteFromRow(row) {
  return {
    id: String(row.id),
    agencyId: String(row.agency_id),
    issueId: String(row.issue_id),
    userId: String(row.user_id || ""),
    body: String(row.body || ""),
    reportSafe: Boolean(row.report_safe),
    createdAt: requiredTimestamp(row.created_at),
  }
}

async function insertRows(token, table, rows) {
  const response = await restFetch(`/${table}`, {
    method: "POST",
    token,
    prefer: "return=minimal",
    body: rows,
  })
  if (!response.ok) {
    throw new Error(`Could not insert ${table}: ${errorMessage(await json(response))}`)
  }
}

async function updateRows(token, table, filters, values) {
  const response = await restFetch(`/${table}?${filters}`, {
    method: "PATCH",
    token,
    prefer: "return=representation",
    body: values,
  })
  const payload = await json(response)
  if (!response.ok || !Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`Could not update ${table}: ${errorMessage(payload)}`)
  }
  return payload[0]
}

async function selectRows(token, path) {
  const response = await restFetch(path, { token })
  const payload = await json(response)
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(`Could not load assurance evidence: ${errorMessage(payload)}`)
  }
  return payload
}

async function selectOne(token, path) {
  return (await selectRows(token, path))[0] || null
}

function requiredTimestamp(value) {
  const date = new Date(String(value || ""))
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Production assurance evidence contained an invalid timestamp.")
  }
  return date.toISOString()
}

function nullableTimestamp(value) {
  return value ? requiredTimestamp(value) : null
}

async function cleanup() {
  if (pdfStoragePath) {
    await storageDelete(pdfStoragePath).catch(() => undefined)
  }
  if (agencyId) {
    await restFetch(`/agencies?id=eq.${encodeURIComponent(agencyId)}`, {
      method: "DELETE",
      service: true,
      prefer: "return=minimal",
    }).catch(() => undefined)
  }
  if (userId) {
    await authFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      service: true,
    }).catch(() => undefined)
  }
}

async function callAppJson(path, options) {
  const response = await callApp(path, options)
  const payload = await json(response)
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${errorMessage(payload)}`)
  }
  return payload
}

function callApp(path, options = {}) {
  return fetch(`${appUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

function authFetch(path, options = {}) {
  const key = options.service ? serviceRoleKey : anonKey
  return fetch(`${authUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

function restFetch(path, options = {}) {
  const key = options.service ? serviceRoleKey : anonKey
  return fetch(`${supabaseUrl}/rest/v1${path}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${options.token || key}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

function storageDelete(path) {
  return fetch(`${supabaseUrl}/storage/v1/object/maintainflow-reports/${encodePath(path)}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })
}

async function json(response) {
  return response.json().catch(() => ({}))
}

function errorMessage(payload) {
  return payload?.message || payload?.msg || payload?.error_description || payload?.error || "unknown error"
}

function requiredEnv(key) {
  const value = env[key]
  if (!value) throw new Error(`${key} is required for the live production assurance smoke.`)
  return stripQuotes(value)
}

function requiredBaseUrl(key) {
  return requiredEnv(key).replace(/\/+$/, "")
}

function publicMonitorUrl(value) {
  let url
  try {
    url = new URL(String(value || ""))
  } catch {
    throw new Error("SMOKE_MONITOR_URL or NEXT_PUBLIC_APP_URL must be a public HTTPS root URL.")
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || hostname === "demo.maintainflow.test"
    || !hostname.includes(".")
    || hostname.endsWith(".")
    || hostname.includes(":")
    || /^[0-9.]+$/.test(hostname)
    || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)
    || hostname.endsWith(".home.arpa")
  ) {
    throw new Error("The assurance smoke monitor must use the credential-free public HTTPS app root.")
  }
  return url.toString()
}

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=")
          return [line.slice(0, separator), stripQuotes(line.slice(separator + 1))]
        })
    )
  } catch {
    return {}
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/")
}
