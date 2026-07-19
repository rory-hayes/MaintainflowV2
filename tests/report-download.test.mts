import assert from "node:assert/strict"
import test from "node:test"
import { currentMonthToDate } from "../src/lib/core/report-period.ts"
import { buildReportSnapshot } from "../src/lib/core/report-state.ts"
import type { Agency, Check, CheckRun, Client, Workflow } from "../src/lib/core/types.ts"
import { bearerToken, getReportDownloadConfig, loadAuthorizedReportPdf } from "../src/lib/supabase/report-download.server.ts"

const config = getReportDownloadConfig({
  NEXT_PUBLIC_SUPABASE_URL: "https://maintainflow.supabase.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
})

test("report download requires a bearer token", () => {
  assert.equal(bearerToken(null), null)
  assert.equal(bearerToken("Basic token"), null)
  assert.equal(bearerToken("Bearer "), null)
  assert.equal(bearerToken("Bearer user-token"), "user-token")
})

test("report download does not fetch storage when RLS hides another agency report", async () => {
  const calls: string[] = []
  const result = await loadAuthorizedReportPdf(config, "intruder-token", "report_other_agency", async (url, init) => {
    calls.push(String(url))
    assert.equal(headersToRecord(init?.headers).authorization, "Bearer intruder-token")
    return Response.json([])
  })

  assert.equal(result.status, 404)
  assert.equal(result.body, "Report PDF has not been prepared.")
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/rest\/v1\/reports/)
})

test("report download rejects mismatched storage paths before fetching private object", async () => {
  const calls: string[] = []
  const row = currentReportRow({ pdf_storage_path: "agency_2/reports/report_1/snapshot-1.pdf" })
  const result = await loadAuthorizedReportPdf(config, "owner-token", "report_1", async (url) => {
    calls.push(String(url))
    return bundleResponse(String(url), row)
  })

  assert.equal(result.status, 409)
  assert.equal(result.body, "Stored report path does not match the authorized report.")
  assert.equal(calls.some((url) => url.includes("/storage/v1/object/")), false)
})

test("legacy PDF pointers remain preserved but cannot be downloaded without a snapshot binding", async () => {
  const calls: string[] = []
  const row = currentReportRow({
    snapshot_version: 0,
    snapshot_json: {},
    evidence_fingerprint: "",
    stale_at: "2026-07-13T10:00:00.000Z",
    pdf_snapshot_version: null,
    pdf_storage_path: "agency_1/reports/report_1.pdf",
    status: "blocked",
  })
  const result = await loadAuthorizedReportPdf(config, "owner-token", "report_1", async (url) => {
    calls.push(String(url))
    return bundleResponse(String(url), row)
  })

  assert.equal(result.status, 409)
  assert.match(String(result.body), /evidence changed/i)
  assert.equal(row.pdf_storage_path, "agency_1/reports/report_1.pdf")
  assert.equal(calls.some((url) => url.includes("/storage/v1/object/")), false)
})

test("a prepared PDF cannot be downloaded when its cited run is legacy browser evidence", async () => {
  const calls: string[] = []
  const row = currentReportRow()
  const result = await loadAuthorizedReportPdf(config, "owner-token", "report_1", async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.includes("/check_runs?")) {
      return Response.json([{ ...checkRunRow(row.period_end), evidence_origin: "legacy_browser" }])
    }
    return bundleResponse(href, row)
  })

  assert.equal(result.status, 409)
  assert.match(String(result.body), /evidence changed/i)
  assert.equal(calls.some((url) => url.includes("/storage/v1/object/")), false)
})

test("a prepared PDF cannot be downloaded when a second active check has no service run", async () => {
  const calls: string[] = []
  const row = currentReportRow()
  const result = await loadAuthorizedReportPdf(config, "owner-token", "report_1", async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.includes("/checks?")) {
      return Response.json([
        checkRow(row.period_end),
        { ...checkRow(row.period_end), id: "check_2", name: "Second active check", last_run_at: null },
      ])
    }
    return bundleResponse(href, row)
  })

  assert.equal(result.status, 409)
  assert.match(String(result.body), /evidence changed/i)
  assert.equal(calls.some((url) => url.includes("/storage/v1/object/")), false)
})

test("report download streams only the current snapshot-bound agency PDF", async () => {
  const calls: string[] = []
  const row = currentReportRow()
  const result = await loadAuthorizedReportPdf(config, "owner-token", "report_1", async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href.includes("/storage/v1/object/")) {
      assert.equal(headersToRecord(init?.headers).authorization, "Bearer service-role-key")
      assert.equal(headersToRecord(init?.headers).apikey, "service-role-key")
      return new Response("pdf-bytes", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
    }

    assert.equal(headersToRecord(init?.headers).authorization, "Bearer owner-token")

    return bundleResponse(href, row)
  })

  assert.equal(result.status, 200)
  assert.equal(result.contentType, "application/pdf")
  assert.equal(result.filename, "client_1-maintain-flow-report.pdf")
  assert.match(
    calls.find((url) => url.includes("/storage/v1/object/")) ?? "",
    /\/storage\/v1\/object\/maintainflow-reports\/agency_1\/reports\/report_1\/snapshot-1\.pdf/
  )
  assert.ok(calls.filter((url) => url.includes("/rest/v1/reports?")).length >= 2)
})

function currentReportRow(overrides: Record<string, unknown> = {}) {
  const period = currentMonthToDate()
  const generatedAt = `${period.periodEnd}T10:00:00.000Z`
  const built = buildReportSnapshot({
    agency: fixtureAgency(),
    client: fixtureClient(),
    reportId: "report_1",
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
    id: "report_1",
    agency_id: "agency_1",
    client_id: "client_1",
    period_start: period.periodStart,
    period_end: period.periodEnd,
    status: built.status,
    narrative: snapshot.narrative,
    readiness_json: { ...built.readiness, pdfGenerated: true },
    metrics_json: snapshot.metrics,
    snapshot_version: 1,
    snapshot_json: snapshot,
    evidence_fingerprint: snapshot.evidenceFingerprint,
    stale_at: null,
    pdf_storage_path: "agency_1/reports/report_1/snapshot-1.pdf",
    pdf_snapshot_version: 1,
    sent_at: null,
    created_at: generatedAt,
    updated_at: generatedAt,
    ...overrides,
  }
}

function bundleResponse(href: string, reportRow: ReturnType<typeof currentReportRow>) {
  if (href.includes("/reports?")) return Response.json([reportRow])
  if (href.includes("/agencies?")) return Response.json([agencyRow()])
  if (href.includes("/clients?")) return Response.json([clientRow()])
  if (href.includes("/workflows?")) return Response.json([workflowRow(reportRow.period_end)])
  if (href.includes("/checks?")) return Response.json([checkRow(reportRow.period_end)])
  if (href.includes("/check_runs?")) return Response.json([checkRunRow(reportRow.period_end)])
  if (
    href.includes("/issues?") ||
    href.includes("/issue_notes?") ||
    href.includes("/report_items?")
  ) {
    return Response.json([])
  }
  return Response.json({ message: `Unexpected URL ${href}` }, { status: 500 })
}

function fixtureAgency(): Agency {
  return {
    id: "agency_1", name: "Northstar", slug: "northstar", plan: "free", trialEndsAt: null,
    stripeCustomerId: "", stripeSubscriptionId: "", stripeSubscriptionStatus: "", complimentaryEntitlement: false,
    complimentaryEntitlementReason: "", reportSenderName: "Alex", reportSenderEmail: "alex@maintainflow.io",
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  }
}

function fixtureClient(): Client {
  return {
    id: "client_1", agencyId: "agency_1", name: "Acme", slug: "acme", website: "https://acme.example",
    ownerUserId: "", reportRecipientEmail: "", reportCadence: "monthly", notes: "", archivedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
  }
}

function fixtureWorkflow(eventDate = currentMonthToDate().periodEnd): Workflow {
  return {
    id: "workflow_1", agencyId: "agency_1", clientId: "client_1", name: "Invoice journey", type: "http_endpoint",
    environment: "production", endpointUrl: "https://acme.example/health", method: "GET", headers: [], requestBody: "",
    expectedStatus: 200, timeoutSeconds: 10, maxLatencyMs: 5000, frequencyMinutes: 60, retries: 2,
    reportIncluded: true, storeRawResponse: false, status: "healthy", healthScore: 100,
    lastCheckRunAt: `${eventDate}T09:00:00.000Z`, archivedAt: null,
    createdAt: `${eventDate.slice(0, 7)}-01T00:00:00.000Z`, updatedAt: `${eventDate}T09:00:00.000Z`,
  }
}

function fixtureCheckRun(eventDate = currentMonthToDate().periodEnd): CheckRun {
  return {
    id: "run_1", agencyId: "agency_1", clientId: "client_1", workflowId: "workflow_1", checkId: "check_1", evidenceOrigin: "service", status: "healthy",
    statusCode: 200, latencyMs: 120, assertionResults: [], resultJson: {},
    safeResponseSummary: "JSON response received (11 bytes); body content was not stored.", errorMessage: "",
    startedAt: `${eventDate}T09:00:00.000Z`, completedAt: `${eventDate}T09:00:00.000Z`, createdAt: `${eventDate}T09:00:00.000Z`,
  }
}

function fixtureCheck(eventDate = currentMonthToDate().periodEnd): Check {
  return {
    id: "check_1", agencyId: "agency_1", workflowId: "workflow_1", name: "Default health check",
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

function headersToRecord(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries())
}
