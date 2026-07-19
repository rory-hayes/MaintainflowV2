import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { renderReportPdfBuffer } from "../src/lib/core/reports/report-pdf.server.ts"
import type { ReportViewModel } from "../src/lib/core/reports/report-view-model.ts"

test("client-ready report PDF renders without email delivery", async () => {
  const buffer = await renderReportPdfBuffer(reportViewModel())

  assert.equal(buffer.subarray(0, 5).toString("latin1"), "%PDF-")
  assert.ok(buffer.length > 8_000)
})

test("client-ready PDF language assigns issue review to the agency without overstating the workflow data model", () => {
  const source = readFileSync(new URL("../src/lib/core/reports/report-pdf.server.ts", import.meta.url), "utf8")

  assert.match(source, /Reliability Report/)
  assert.match(source, /Client journey reliability report/)
  assert.match(source, /Business-journey coverage, outside-in evidence, agency-reviewed issues, repair evidence/)
  assert.match(source, /Reliability Scorecard/)
  assert.match(source, /Workflows included/)
  assert.match(source, /Journey and Workflow Coverage/)
  assert.match(source, /Recent Assurance Evidence/)
  assert.match(source, /period runs shown/)
  assert.match(source, /Agency-Reviewed Issues/)
  assert.match(source, /Resolved Issues and Repair Evidence/)
  assert.doesNotMatch(source, /title: "Verified Repairs"/)
  assert.doesNotMatch(source, /Maintenance Report|Private client maintenance report|Resolved Maintenance Proof/)
})

test("deployment readiness requires Resend for Business Evals without restoring retired pilot email checks", () => {
  const source = readFileSync(new URL("../scripts/local-deploy-readiness.mjs", import.meta.url), "utf8")

  assert.match(source, /"RESEND_API_KEY"/)
  assert.match(source, /"RESEND_INBOUND_WEBHOOK_SECRET"/)
  assert.match(source, /Business Evals production providers are incomplete/)
  assert.doesNotMatch(source, /checkReportEmailEnv/)
  assert.doesNotMatch(source, /Report email delivery/)
  assert.doesNotMatch(source, /Pilot lead notifications/)
})

test("live assurance smoke proves verification truth and private snapshot PDF delivery", () => {
  const source = readFileSync(new URL("../scripts/live-assurance-supabase-smoke.mjs", import.meta.url), "utf8")

  assert.match(source, /Authenticated browser credentials were able to stamp service-issued evidence/)
  assert.match(
    source,
    /const legacyRunResponse = await restFetch\("\/check_runs", \{[\s\S]*?body: legacyRunPayload\(legacyRunId\)[\s\S]*?if \(expectServiceOnlyEvidence\) \{[\s\S]*?if \(legacyRunResponse\.ok\)[\s\S]*?cannot create any check evidence[\s\S]*?\} else \{[\s\S]*?if \(!legacyRunResponse\.ok\)[\s\S]*?legacyRun\?\.evidence_origin !== "legacy_browser"/,
  )
  assert.match(source, /body: \{ checkId: ids\.checkId \}/)
  assert.match(source, /publicMonitorUrl\(env\.SMOKE_MONITOR_URL \|\| env\.NEXT_PUBLIC_APP_URL \|\| appUrl\)/)
  assert.match(source, /config_json: endpointConfig\(503\)/)
  assert.match(source, /config_json: endpointConfig\(200\)/)
  assert.doesNotMatch(source, /demo\.maintainflow\.test\/failed/)
  assert.match(source, /resolvedIssue\.verification_run_id !== ids\.verificationRunId/)
  assert.match(source, /snapshot_json: built\.snapshot/)
  assert.match(source, /downloaded the authorized private report PDF/)
  assert.match(source, /verified private report download rejects unauthenticated access/)
  assert.match(source, /snapshot-1\.pdf/)
  assert.doesNotMatch(source, /legacyRowsForMissing|V1\.5/)
  assert.doesNotMatch(source, /\/email/)
  assert.doesNotMatch(source, /Resend/)
})

function reportViewModel(): ReportViewModel {
  return {
    reportId: "rep_1",
    agency: {
      id: "ag_1",
      name: "Northstar Automations",
      reportSenderName: "Alex Morgan",
      reportSenderEmail: "alex@maintainflow.io",
    },
    client: {
      id: "cl_1",
      name: "Acme AI Systems",
      website: "https://acme.example",
      reportRecipientEmail: "ops@acme.example",
    },
    period: {
      start: "2026-06-01",
      end: "2026-06-30",
      label: "2026-06-01 to 2026-06-30",
    },
    generatedAt: "2026-06-30T12:00:00.000Z",
    summary: "Maintain Flow monitored the production workflow set and kept client-safe proof for the period.",
    reportSafeNarrative:
      "Maintain Flow monitored two production workflows for Acme AI Systems and recorded recurring health evidence across the period. One degraded sync was detected, resolved, and verified with a passing follow-up check. No unresolved high-risk reportable issues remain for the period.",
    scorecard: {
      workflowsMonitored: 2,
      checksRun: 38,
      passRate: 97.4,
      issuesDetected: 1,
      issuesResolved: 1,
      unresolvedHighRiskIssues: 0,
      averageLatencyMs: 184,
    },
    workflowCoverage: [
      {
        workflowId: "wf_1",
        name: "CRM enrichment sync",
        endpointUrl: "https://acme.example/api/workflows/crm-enrichment/health",
        method: "GET",
        status: "healthy",
        healthScore: 100,
        checksRun: 20,
        lastCheckRunAt: "2026-06-30T11:00:00.000Z",
      },
      {
        workflowId: "wf_2",
        name: "Invoice follow-up automation",
        endpointUrl: "https://acme.example/api/workflows/invoice-follow-up/health",
        method: "GET",
        status: "healthy",
        healthScore: 95,
        checksRun: 18,
        lastCheckRunAt: "2026-06-30T10:00:00.000Z",
      },
    ],
    checkRuns: [
      {
        checkRunId: "run_1",
        workflowId: "wf_1",
        workflowName: "CRM enrichment sync",
        status: "healthy",
        statusCode: 200,
        latencyMs: 178,
        summary: "The workflow returned a healthy response and expected status code.",
        createdAt: "2026-06-30T11:00:00.000Z",
      },
      {
        checkRunId: "run_2",
        workflowId: "wf_2",
        workflowName: "Invoice follow-up automation",
        status: "healthy",
        statusCode: 200,
        latencyMs: 190,
        summary: "The endpoint returned a valid response after the follow-up queue was drained.",
        createdAt: "2026-06-30T10:00:00.000Z",
      },
    ],
    issues: [],
    resolvedIssues: [
      {
        issueId: "iss_1",
        workflowId: "wf_2",
        workflowName: "Invoice follow-up automation",
        title: "Follow-up queue recovered",
        severity: "medium",
        status: "resolved",
        reportSafeSummary: "The queue delay was resolved and the next check confirmed normal operation.",
        createdAt: "2026-06-20T10:00:00.000Z",
        resolvedAt: "2026-06-20T12:00:00.000Z",
      },
    ],
    recommendations: [
      "Keep the invoice follow-up workflow on the current hourly check cadence for the next reporting period.",
      "Review CRM sync credentials during the next scheduled maintenance window.",
    ],
    evidenceItems: [
      {
        id: "ri_1",
        sourceType: "check_run",
        sourceId: "run_1",
        title: "CRM enrichment sync healthy",
        body: "The latest check returned HTTP 200 within the configured latency target.",
        reportSafe: true,
        createdAt: "2026-06-30T11:00:00.000Z",
      },
      {
        id: "ri_2",
        sourceType: "issue",
        sourceId: "iss_1",
        title: "Follow-up queue recovered",
        body: "The queue delay was resolved and verified with a passing follow-up check.",
        reportSafe: true,
        createdAt: "2026-06-20T12:00:00.000Z",
      },
    ],
  }
}
