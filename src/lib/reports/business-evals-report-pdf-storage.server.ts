import "server-only"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { getBusinessEvalsEntitlement } from "@/lib/api/business-evals-entitlements.server"
import {
  renderBusinessEvalReportPdf,
  type BusinessEvalReportPdfModel,
} from "@/lib/reports/business-evals-report-pdf.server"
import { getSupabaseServerConfig, supabaseServiceJson } from "@/lib/supabase/server"
import {
  createReportPdfStoragePath,
  encodeStorageObjectPath,
  isExpectedReportPdfStoragePath,
  REPORT_PDF_BUCKET,
} from "@/lib/supabase/report-storage-path"

type Row = Record<string, unknown>

export async function prepareBusinessEvalReportPdf(agencyId: string, reportId: string) {
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  if (!entitlement.features.pdf) {
    throw new BusinessEvalsApiError(402, "PDF_REPORTING_REQUIRED", "PDF reports are available on Solo, Team and Agency plans.")
  }
  const report = await loadBusinessEvalReport(agencyId, reportId)
  const model = await createPdfModel(agencyId, report, entitlement.features.whiteLabel)
  const pdfBuffer = await renderBusinessEvalReportPdf(model)
  const path = createReportPdfStoragePath(agencyId, reportId, Number(report.snapshot_version))
  const config = getSupabaseServerConfig()
  const storageResponse = await fetch(
    `${config.supabaseUrl}/storage/v1/object/${REPORT_PDF_BUCKET}/${encodeStorageObjectPath(path)}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/pdf",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "x-upsert": "true",
      },
      body: pdfBuffer,
    }
  )
  if (!storageResponse.ok) {
    const detail = await storageResponse.text().catch(() => "")
    throw new BusinessEvalsApiError(502, "PDF_STORAGE_FAILED", detail || "The private report PDF could not be stored.")
  }

  const rows = await supabaseServiceJson<Row[]>(`reports?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${reportId}`,
    snapshot_version: `eq.${Number(report.snapshot_version)}`,
    eval_evidence_fingerprint: `eq.${String(report.eval_evidence_fingerprint)}`,
    status: "eq.ready",
    stale_at: "is.null",
    select: "id,pdf_storage_path,pdf_snapshot_version,updated_at",
  })}`, {
    method: "PATCH",
    body: JSON.stringify({
      pdf_storage_path: path,
      pdf_snapshot_version: Number(report.snapshot_version),
      updated_at: new Date().toISOString(),
    }),
  })
  if (!rows[0]) {
    throw new BusinessEvalsApiError(409, "REPORT_CHANGED", "The report changed while its PDF was being prepared. Refresh and try again.")
  }
  return {
    pdfStoragePath: String(rows[0].pdf_storage_path),
    snapshotVersion: Number(rows[0].pdf_snapshot_version),
    updatedAt: String(rows[0].updated_at),
  }
}

export async function loadBusinessEvalReportPdf(agencyId: string, reportId: string) {
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  if (!entitlement.features.pdf) {
    throw new BusinessEvalsApiError(402, "PDF_REPORTING_REQUIRED", "PDF reports are available on Solo, Team and Agency plans.")
  }
  const report = await loadBusinessEvalReport(agencyId, reportId)
  const snapshotVersion = Number(report.snapshot_version)
  const path = String(report.pdf_storage_path ?? "")
  if (!path || Number(report.pdf_snapshot_version) !== snapshotVersion) {
    throw new BusinessEvalsApiError(404, "PDF_NOT_READY", "Prepare the current report PDF before downloading it.")
  }
  if (!isExpectedReportPdfStoragePath(path, agencyId, reportId, snapshotVersion)) {
    throw new BusinessEvalsApiError(409, "PDF_PATH_MISMATCH", "The stored PDF does not match this report snapshot.")
  }
  const config = getSupabaseServerConfig()
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/${REPORT_PDF_BUCKET}/${encodeStorageObjectPath(path)}`,
    { headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` } }
  )
  if (!response.ok || !response.body) {
    throw new BusinessEvalsApiError(response.status || 404, "PDF_NOT_FOUND", "The private report PDF could not be loaded.")
  }
  const projectRows = await supabaseServiceJson<Row[]>(`clients?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${String(report.client_id)}`,
    select: "name",
    limit: "1",
  })}`)
  return {
    body: response.body,
    contentType: response.headers.get("content-type") || "application/pdf",
    filename: `${filenameSegment(String(projectRows[0]?.name ?? "project"))}-business-evals-report.pdf`,
  }
}

export async function isBusinessEvalReport(agencyId: string, reportId: string) {
  const rows = await supabaseServiceJson<Row[]>(`reports?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${reportId}`,
    select: "id,eval_snapshot_idempotency_key",
    limit: "1",
  })}`)
  const report = rows[0]
  if (!report) {
    throw new BusinessEvalsApiError(404, "REPORT_NOT_FOUND", "Report not found in the selected workspace.")
  }
  return Boolean(report.eval_snapshot_idempotency_key)
}

async function loadBusinessEvalReport(agencyId: string, reportId: string) {
  const rows = await supabaseServiceJson<Row[]>(`reports?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${reportId}`,
    select: "id,agency_id,client_id,period_start,period_end,status,snapshot_version,snapshot_json,eval_evidence_fingerprint,eval_snapshot_idempotency_key,stale_at,pdf_storage_path,pdf_snapshot_version",
    limit: "1",
  })}`)
  const report = rows[0]
  if (!report?.eval_snapshot_idempotency_key) throw new BusinessEvalsApiError(404, "EVAL_REPORT_NOT_FOUND", "Business eval report not found.")
  const snapshot = asRecord(report.snapshot_json)
  if (
    report.status !== "ready"
    || report.stale_at
    || Number(report.snapshot_version) < 1
    || Number(snapshot.snapshotVersion) !== Number(report.snapshot_version)
    || String(snapshot.evidenceFingerprint ?? "") !== String(report.eval_evidence_fingerprint ?? "")
  ) {
    throw new BusinessEvalsApiError(409, "REPORT_NOT_READY", "Refresh the immutable business-eval snapshot before using its PDF.")
  }
  return report
}

async function createPdfModel(agencyId: string, report: Row, whiteLabel: boolean): Promise<BusinessEvalReportPdfModel> {
  const [agencyRows, projectRows] = await Promise.all([
    supabaseServiceJson<Row[]>(`agencies?${query({ id: `eq.${agencyId}`, select: "name", limit: "1" })}`),
    supabaseServiceJson<Row[]>(`clients?${query({ agency_id: `eq.${agencyId}`, id: `eq.${String(report.client_id)}`, select: "name", limit: "1" })}`),
  ])
  const snapshot = asRecord(report.snapshot_json)
  const metrics = asRecord(snapshot.metrics)
  return {
    brandName: whiteLabel ? String(agencyRows[0]?.name ?? "Business Evals") : "Maintain Flow",
    projectName: String(projectRows[0]?.name ?? "Project"),
    periodStart: String(report.period_start),
    periodEnd: String(report.period_end),
    generatedAt: String(snapshot.generatedAt ?? new Date().toISOString()),
    snapshotVersion: Number(report.snapshot_version),
    evidenceFingerprint: String(report.eval_evidence_fingerprint),
    metrics: {
      journeysCovered: numeric(metrics.journeysCovered),
      evalRuns: numeric(metrics.evalRuns),
      passedRuns: numeric(metrics.passedRuns),
      passRate: numeric(metrics.passRate),
      incidents: numeric(metrics.incidents),
      recoveries: numeric(metrics.recoveries),
    },
    journeys: asRecords(snapshot.journeys).map((item) => ({
      name: String(item.name ?? "Journey"),
      template: String(item.template ?? "legacy_endpoint"),
      runCount: numeric(item.runCount),
      latestVerdict: String(item.latestVerdict ?? "inconclusive"),
    })),
    runs: asRecords(snapshot.runs).map((item) => ({
      verdict: String(item.verdict ?? "inconclusive"),
      summary: String(item.summary ?? ""),
      businessImpact: String(item.businessImpact ?? ""),
      cleanupStatus: String(item.cleanupStatus ?? "not_required"),
      completedAt: String(item.completedAt ?? ""),
    })),
    incidents: asRecords(snapshot.incidents).map((item) => ({
      title: String(item.title ?? "Incident"),
      severity: String(item.severity ?? "medium"),
      status: String(item.status ?? "open"),
      reportSafeSummary: String(item.reportSafeSummary ?? ""),
    })),
  }
}

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

function asRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function numeric(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function filenameSegment(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "").slice(0, 80) || "project"
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
