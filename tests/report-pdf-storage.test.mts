import assert from "node:assert/strict"
import test from "node:test"
import { currentMonthToDate, dateInputValue, type ReportPeriod } from "../src/lib/core/report-period.ts"
import { buildReportSnapshot } from "../src/lib/core/report-state.ts"
import type { Agency, Check, CheckRun, Client, Workflow } from "../src/lib/core/types.ts"

import {
  getReportPdfStorageConfig,
  prepareAndStoreAuthorizedReportPdf,
  ReportPdfStorageError,
} from "../src/lib/supabase/report-pdf-storage.server.ts"

test("PDF preparation requires the server-only storage credential", () => {
  assert.equal(getReportPdfStorageConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  }).enabled, false)
})

test("server-side PDF preparation binds a versioned private object to the exact snapshot", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const row = reportApiRow()
  row.snapshot_json = reverseObjectKeys(row.snapshot_json) as typeof row.snapshot_json
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init })

    if (init?.method === "PATCH" && href.includes("/reports?")) {
      const body = JSON.parse(String(init.body))
      assert.equal(body.pdf_storage_path, "ag_1/reports/rep_1/snapshot-1.pdf")
      assert.equal(body.pdf_snapshot_version, 1)
      assert.equal(body.readiness_json.pdfGenerated, true)
      assert.match(href, /snapshot_version=eq\.1/)
      assert.ok(href.includes(`evidence_fingerprint=eq.${row.evidence_fingerprint}`))
      assert.match(href, /status=eq\.ready/)
      assert.match(href, /stale_at=is\.null/)
      return jsonResponse([{ id: "rep_1", snapshot_version: 1, pdf_snapshot_version: 1 }])
    }
    if (href.includes("/storage/v1/object/maintainflow-reports/ag_1/reports/rep_1/snapshot-1.pdf")) {
      const body = init?.body
      assert.ok(Buffer.isBuffer(body))
      assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-")
      assert.equal(headersToRecord(init?.headers).authorization, "Bearer service-role")
      assert.equal(headersToRecord(init?.headers).apikey, "service-role")
      assert.equal(headersToRecord(init?.headers)["x-upsert"], "false")
      return new Response(null, { status: 200 })
    }

    return bundleResponse(href, row)
  }

  const result = await prepareAndStoreAuthorizedReportPdf(config(), "user-token", "rep_1", fetchImpl as typeof fetch)

  assert.equal(result.pdfStoragePath, "ag_1/reports/rep_1/snapshot-1.pdf")
  assert.equal(result.status, "ready")
  assert.equal(calls.filter((call) => call.init?.method === "PATCH").length, 1)
})

test("evidence changing during upload cannot bind an obsolete PDF", async () => {
  const uploadedPaths: string[] = []
  const row = reportApiRow()
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)

    if (href.includes("/storage/v1/object/")) {
      uploadedPaths.push(href)
      return new Response(null, { status: 200 })
    }
    if (init?.method === "PATCH" && href.includes("/reports?")) {
      return jsonResponse([])
    }

    return bundleResponse(href, row)
  }

  await assert.rejects(
    () => prepareAndStoreAuthorizedReportPdf(config(), "user-token", "rep_1", fetchImpl as typeof fetch),
    (error: unknown) =>
      error instanceof ReportPdfStorageError &&
      error.status === 409 &&
      /changed while the PDF was being prepared/i.test(error.message)
  )
  assert.equal(uploadedPaths.length, 1)
  assert.match(uploadedPaths[0], /snapshot-1\.pdf$/)
})

test("a member cannot prepare a PDF from forged snapshot metrics with a valid fingerprint", async () => {
  const row = reportApiRow()
  row.snapshot_json = {
    ...row.snapshot_json,
    metrics: { ...row.snapshot_json.metrics, passRate: 17 },
  }
  let storageCalled = false

  await assert.rejects(
    () => prepareAndStoreAuthorizedReportPdf(config(), "user-token", "rep_1", (async (url) => {
      const href = String(url)
      if (href.includes("/storage/v1/object/")) storageCalled = true
      return bundleResponse(href, row)
    }) as typeof fetch),
    (error: unknown) => error instanceof ReportPdfStorageError && error.status === 409
  )
  assert.equal(storageCalled, false)
})

test("PDF preparation rejects a newly active check without service evidence", async () => {
  const row = reportApiRow()
  let storageCalled = false

  await assert.rejects(
    () => prepareAndStoreAuthorizedReportPdf(config(), "user-token", "rep_1", (async (url) => {
      const href = String(url)
      if (href.includes("/storage/v1/object/")) storageCalled = true
      if (href.includes("/checks?")) {
        return jsonResponse([
          checkRow(row.period_end),
          { ...checkRow(row.period_end), id: "check_2", name: "Second active check", last_run_at: null },
        ])
      }
      return bundleResponse(href, row)
    }) as typeof fetch),
    (error: unknown) => error instanceof ReportPdfStorageError && error.status === 409
  )
  assert.equal(storageCalled, false)
})

test("direct database writes cannot prepare partial or historical report periods", async () => {
  const current = currentMonthToDate()
  const secondDay = new Date(`${current.periodStart}T00:00:00.000Z`)
  secondDay.setUTCDate(2)
  const cases = [
    { name: "partial", period: { periodStart: dateInputValue(secondDay), periodEnd: current.periodEnd } },
    { name: "historical", period: previousMonthPeriod(current) },
  ]

  for (const item of cases) {
    const row = reportApiRow(item.period)
    let storageCalled = false
    assert.equal(row.status, "ready", `${item.name} fixture should otherwise be PDF-ready`)

    await assert.rejects(
      () => prepareAndStoreAuthorizedReportPdf(config(), "user-token", "rep_1", (async (url) => {
        const href = String(url)
        if (href.includes("/storage/v1/object/")) storageCalled = true
        return bundleResponse(href, row)
      }) as typeof fetch),
      (error: unknown) => error instanceof ReportPdfStorageError && error.status === 409
    )
    assert.equal(storageCalled, false, `${item.name} report must be rejected before storage`)
  }
})

function config() {
  return getReportPdfStorageConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  })
}

function reportApiRow(period: ReportPeriod = currentMonthToDate()) {
  const generatedAt = `${period.periodEnd}T10:00:00.000Z`
  const built = buildReportSnapshot({
    agency: fixtureAgency(),
    client: fixtureClient(),
    reportId: "rep_1",
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    version: 1,
    generatedAt,
    workflows: [fixtureWorkflow(period.periodEnd)],
    checks: [fixtureCheck(period.periodEnd)],
    checkRuns: [fixtureCheckRun(period.periodEnd)],
    issues: [],
    issueNotes: [],
  })
  const snapshot = built.snapshot
  return {
    id: "rep_1",
    agency_id: "ag_1",
    client_id: "cl_1",
    period_start: period.periodStart,
    period_end: period.periodEnd,
    status: built.status,
    narrative: snapshot.narrative,
    readiness_json: built.readiness,
    metrics_json: snapshot.metrics,
    snapshot_version: 1,
    snapshot_json: snapshot,
    evidence_fingerprint: snapshot.evidenceFingerprint,
    stale_at: null,
    pdf_storage_path: null,
    pdf_snapshot_version: null,
    sent_at: null,
    created_at: generatedAt,
    updated_at: generatedAt,
  }
}

function bundleResponse(href: string, reportRow: ReturnType<typeof reportApiRow>) {
  if (href.includes("/reports?")) return jsonResponse([reportRow])
  if (href.includes("/agencies?")) return jsonResponse([agencyRow()])
  if (href.includes("/clients?")) return jsonResponse([clientRow()])
  if (href.includes("/workflows?")) return jsonResponse([workflowRow(reportRow.period_end)])
  if (href.includes("/checks?")) return jsonResponse([checkRow(reportRow.period_end)])
  if (href.includes("/check_runs?")) return jsonResponse([checkRunRow(reportRow.period_end)])
  if (
    href.includes("/issues?") ||
    href.includes("/issue_notes?") ||
    href.includes("/report_items?")
  ) {
    return jsonResponse([])
  }
  return jsonResponse({ message: `Unexpected URL ${href}` }, false, 500)
}

function fixtureAgency(): Agency {
  return {
    id: "ag_1", name: "Northstar Automations", slug: "northstar", plan: "free", trialEndsAt: null,
    stripeCustomerId: "", stripeSubscriptionId: "", stripeSubscriptionStatus: "", complimentaryEntitlement: false,
    complimentaryEntitlementReason: "", reportSenderName: "Alex Morgan", reportSenderEmail: "alex@maintainflow.io",
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  }
}

function fixtureClient(): Client {
  return {
    id: "cl_1", agencyId: "ag_1", name: "Acme AI Systems", slug: "acme-ai-systems", website: "https://acme.example",
    ownerUserId: "", reportRecipientEmail: "", reportCadence: "monthly", notes: "", archivedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  }
}

function fixtureWorkflow(eventDate = currentMonthToDate().periodEnd): Workflow {
  return {
    id: "wf_1", agencyId: "ag_1", clientId: "cl_1", name: "Invoice journey", type: "http_endpoint",
    environment: "production", endpointUrl: "https://acme.example/health", method: "GET", headers: [], requestBody: "",
    expectedStatus: 200, timeoutSeconds: 10, maxLatencyMs: 5000, frequencyMinutes: 60, retries: 2,
    reportIncluded: true, storeRawResponse: false, status: "healthy", healthScore: 100,
    lastCheckRunAt: `${eventDate}T09:00:00.000Z`, archivedAt: null,
    createdAt: `${eventDate.slice(0, 7)}-01T00:00:00.000Z`, updatedAt: `${eventDate}T09:00:00.000Z`,
  }
}

function fixtureCheckRun(eventDate = currentMonthToDate().periodEnd): CheckRun {
  return {
    id: "run_1", agencyId: "ag_1", clientId: "cl_1", workflowId: "wf_1", checkId: "check_1", evidenceOrigin: "service", status: "healthy",
    statusCode: 200, latencyMs: 120, assertionResults: [], resultJson: {},
    safeResponseSummary: "JSON response received (11 bytes); body content was not stored.", errorMessage: "",
    startedAt: `${eventDate}T09:00:00.000Z`, completedAt: `${eventDate}T09:00:00.000Z`, createdAt: `${eventDate}T09:00:00.000Z`,
  }
}

function fixtureCheck(eventDate = currentMonthToDate().periodEnd): Check {
  return {
    id: "check_1", agencyId: "ag_1", workflowId: "wf_1", name: "Default health check",
    type: "health", pluginId: "endpoint", configJson: { expectedStatus: 200 }, enabled: true,
    pendingSetup: false, scheduleMinutes: 60, assertions: [],
    lastRunAt: `${eventDate}T09:00:00.000Z`, nextRunAt: `${eventDate}T10:00:00.000Z`,
    createdAt: `${eventDate.slice(0, 7)}-01T00:00:00.000Z`, updatedAt: `${eventDate}T09:00:00.000Z`,
  }
}

function agencyRow() {
  const agency = fixtureAgency()
  return { id: agency.id, name: agency.name, slug: agency.slug, plan: agency.plan, report_sender_name: agency.reportSenderName, report_sender_email: agency.reportSenderEmail, created_at: agency.createdAt, updated_at: agency.updatedAt }
}

function clientRow() {
  const client = fixtureClient()
  return { id: client.id, agency_id: client.agencyId, name: client.name, slug: client.slug, website: client.website, report_recipient_email: client.reportRecipientEmail, report_cadence: client.reportCadence, created_at: client.createdAt, updated_at: client.updatedAt }
}

function workflowRow(eventDate: string) {
  const workflow = fixtureWorkflow(eventDate)
  return { id: workflow.id, agency_id: workflow.agencyId, client_id: workflow.clientId, name: workflow.name, type: workflow.type, environment: workflow.environment, endpoint_url: workflow.endpointUrl, method: workflow.method, encrypted_auth_config: { headers: [] }, request_body: "", expected_status: 200, timeout_seconds: 10, max_latency_ms: 5000, frequency_minutes: 60, retries: 2, report_included: true, store_raw_response: false, status: workflow.status, health_score: workflow.healthScore, last_check_run_at: postgrestTimestamp(workflow.lastCheckRunAt!), archived_at: null, created_at: postgrestTimestamp(workflow.createdAt), updated_at: postgrestTimestamp(workflow.updatedAt) }
}

function checkRow(eventDate: string) {
  const check = fixtureCheck(eventDate)
  return { id: check.id, agency_id: check.agencyId, workflow_id: check.workflowId, name: check.name, type: check.type, plugin_id: check.pluginId, config_json: check.configJson, enabled: check.enabled, pending_setup: check.pendingSetup, schedule_minutes: check.scheduleMinutes, assertions_json: check.assertions, last_run_at: postgrestTimestamp(check.lastRunAt!), next_run_at: postgrestTimestamp(check.nextRunAt!), created_at: postgrestTimestamp(check.createdAt), updated_at: postgrestTimestamp(check.updatedAt) }
}

function checkRunRow(eventDate: string) {
  const run = fixtureCheckRun(eventDate)
  return { id: run.id, agency_id: run.agencyId, client_id: run.clientId, workflow_id: run.workflowId, check_id: run.checkId, evidence_origin: run.evidenceOrigin, status: run.status, status_code: run.statusCode, latency_ms: run.latencyMs, assertion_results_json: run.assertionResults, result_json: run.resultJson, safe_response_summary: run.safeResponseSummary, error_message: run.errorMessage, started_at: postgrestTimestamp(run.startedAt), completed_at: postgrestTimestamp(run.completedAt), created_at: postgrestTimestamp(run.createdAt) }
}

function postgrestTimestamp(value: string) {
  return value.replace(/Z$/, "+00:00")
}

function previousMonthPeriod(current: ReportPeriod): ReportPeriod {
  const currentStart = new Date(`${current.periodStart}T00:00:00.000Z`)
  const previousEnd = new Date(currentStart.getTime() - 1)
  return {
    periodStart: `${previousEnd.getUTCFullYear()}-${String(previousEnd.getUTCMonth() + 1).padStart(2, "0")}-01`,
    periodEnd: dateInputValue(previousEnd),
  }
}

function jsonResponse(value: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  } as Response
}

function headersToRecord(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries())
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)])
  )
}
