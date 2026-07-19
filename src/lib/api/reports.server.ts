import "server-only"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { getProject } from "@/lib/api/projects.server"
import { legacyReportMetrics } from "@/lib/evals/legacy-endpoint-compat"
import { buildReportSafeContent } from "@/lib/reports/report-safe-contract"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export async function listReports(input: { agencyId: string; limit: number; cursor?: string; projectId?: string }) {
  const offset = decodeCursor(input.cursor)
  const filters: Record<string, string> = {
    select: "id,client_id,period_start,period_end,status,snapshot_version,snapshot_json,eval_snapshot_idempotency_key,eval_coverage_snapshot_json,evidence_fingerprint,eval_evidence_fingerprint,stale_at,pdf_storage_path,pdf_snapshot_version,created_at,updated_at",
    agency_id: `eq.${input.agencyId}`,
    order: "created_at.desc,id.desc",
    limit: String(input.limit),
    offset: String(offset),
  }
  if (input.projectId) filters.client_id = `eq.${input.projectId}`
  const rows = await supabaseServiceJson<Row[]>(`reports?${query(filters)}`)
  const projectIds = [...new Set(rows.map((row) => String(row.client_id ?? "")).filter(Boolean))]
  const reportIds = rows.map((row) => String(row.id ?? "")).filter(Boolean)
  const [projects, activeShareFlags] = await Promise.all([
    projectIds.length ? supabaseServiceJson<Row[]>(`clients?${query({
        select: "id,name",
        agency_id: `eq.${input.agencyId}`,
        id: `in.(${projectIds.join(",")})`,
      })}`) : Promise.resolve([]),
    activeShareFlagsForReports(input.agencyId, reportIds),
  ])
  const projectNames = new Map(projects.map((project) => [String(project.id), String(project.name ?? "Historical project")]))
  const activeShares = new Map(activeShareFlags.map((flag) => [String(flag.report_id), Boolean(flag.has_active_share)]))
  return {
    reports: rows.map((row) => ({
      ...presentReport(row),
      projectName: projectNames.get(String(row.client_id)) ?? "Historical project",
      hasActiveShare: activeShares.get(String(row.id)) ?? false,
    })),
    nextCursor: rows.length === input.limit ? encodeCursor(offset + rows.length) : null,
  }
}

export async function getReport(agencyId: string, reportId: string) {
  const rows = await supabaseServiceJson<Row[]>(`reports?${query({
    select: "id,client_id,period_start,period_end,status,narrative,readiness_json,metrics_json,snapshot_version,snapshot_json,eval_snapshot_idempotency_key,eval_coverage_snapshot_json,evidence_fingerprint,eval_evidence_fingerprint,stale_at,pdf_storage_path,pdf_snapshot_version,created_at,updated_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${reportId}`,
    limit: "1",
  })}`)
  if (!rows[0]) throw new BusinessEvalsApiError(404, "REPORT_NOT_FOUND", "Report not found.")
  const [shares, projects, activeShareFlags] = await Promise.all([
    supabaseServiceJson<Row[]>(`report_share_links?${query({
      select: "id,snapshot_version,expires_at,revoked_at,access_count,last_accessed_at,created_at",
      agency_id: `eq.${agencyId}`,
      report_id: `eq.${reportId}`,
      order: "created_at.desc",
      limit: "100",
    })}`),
    supabaseServiceJson<Row[]>(`clients?${query({
      select: "id,name,archived_at",
      agency_id: `eq.${agencyId}`,
      id: `eq.${String(rows[0].client_id)}`,
      limit: "1",
    })}`),
    activeShareFlagsForReports(agencyId, [reportId]),
  ])
  return {
    ...presentReport(rows[0]),
    shares,
    projectName: String(projects[0]?.name ?? "Historical project"),
    projectArchivedAt: projects[0]?.archived_at ? String(projects[0].archived_at) : null,
    hasActiveShare: Boolean(activeShareFlags[0]?.has_active_share),
  }
}

export async function createReportSnapshot(input: {
  agencyId: string
  projectId: string
  userId: string
  periodStart: string
  periodEnd: string
  idempotencyKey: string
}) {
  await getProject(input.agencyId, input.projectId)
  if (input.periodEnd < input.periodStart || input.periodEnd > new Date().toISOString().slice(0, 10)) {
    throw new BusinessEvalsApiError(400, "INVALID_REPORT_PERIOD", "Report periods cannot be inverted or end in the future.")
  }
  const rows = await supabaseServiceJson<Row[]>("rpc/create_business_eval_report_snapshot", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_client_id: input.projectId,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
      p_created_by_user_id: input.userId,
      p_idempotency_key: input.idempotencyKey,
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Supabase did not return the report snapshot.")
  const reportId = String(row.report_id ?? row.id)
  return getReport(input.agencyId, reportId)
}

function presentReport(row: Row) {
  const snapshot = row.snapshot_json && typeof row.snapshot_json === "object" ? row.snapshot_json as Row : {}
  const compatibility = legacyReportMetrics(row)
  const evidenceFingerprint = String(row.eval_evidence_fingerprint || row.evidence_fingerprint || "")
  const safeContent = buildReportSafeContent({
    snapshot,
    source: compatibility.source,
    snapshotVersion: Number(row.snapshot_version ?? 0),
    evidenceFingerprint,
    fallbackSummary: row.narrative,
    fallbackMetrics: compatibility.metrics,
    fallbackJourneysCovered: compatibility.journeysCovered,
    generatedAt: row.created_at,
  })
  return {
    id: String(row.id),
    projectId: String(row.client_id),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    status: String(row.status),
    snapshotVersion: Number(row.snapshot_version ?? 0),
    source: compatibility.source,
    evidenceModel: compatibility.source === "legacy_endpoint" ? "Legacy endpoint" : "Business eval",
    stageEvidenceAvailable: compatibility.source === "business_eval",
    shareEligible: compatibility.source === "business_eval",
    coverageDisclosure: compatibility.source === "legacy_endpoint"
      ? "Historical deterministic endpoint-monitor evidence. This report does not contain browser-stage, email, screenshot, or cleanup proof."
      : "Business-eval journey evidence only. Legacy endpoint checks are not represented as browser-stage evidence in this snapshot.",
    ...safeContent,
    evidenceFingerprint: safeContent.provenance.evidenceFingerprint,
    staleAt: row.stale_at ? String(row.stale_at) : null,
    pdfReady: Boolean(row.pdf_storage_path && Number(row.pdf_snapshot_version) === Number(row.snapshot_version)),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

function encodeCursor(offset: number) {
  return Buffer.from(String(offset)).toString("base64url")
}

function decodeCursor(cursor?: string) {
  if (!cursor) return 0
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"))
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

async function activeShareFlagsForReports(agencyId: string, reportIds: string[]) {
  if (!reportIds.length) return []
  return supabaseServiceJson<Row[]>("rpc/get_business_eval_report_active_share_flags", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: agencyId,
      p_report_ids: reportIds.slice(0, 100),
    }),
  })
}
