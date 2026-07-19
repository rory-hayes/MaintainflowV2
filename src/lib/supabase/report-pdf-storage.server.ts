import { renderReportPdfBuffer } from "../core/reports/report-pdf.server.ts"
import {
  createBundleViewModel,
  loadAuthorizedReportBundle,
  reportBundleSnapshotIsCurrent,
  type ReportBundleConfig,
} from "./report-bundle.server.ts"
import { createReportPdfStoragePath, encodeStorageObjectPath, REPORT_PDF_BUCKET } from "./report-storage-path.ts"

export class ReportPdfStorageError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ReportPdfStorageError"
    this.status = status
  }
}

export type ReportPdfStorageConfig = ReturnType<typeof getReportPdfStorageConfig>
type ReportPdfStorageEnv = {
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export type PreparedReportPdfResult = {
  pdfStoragePath: string
  status: string
  updatedAt: string
}

export function getReportPdfStorageConfig(env?: ReportPdfStorageEnv) {
  const source = env ?? process.env
  const supabaseUrl = source.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const anonKey = source.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  const serviceRoleKey = source.SUPABASE_SERVICE_ROLE_KEY ?? ""
  return {
    enabled: Boolean(supabaseUrl && anonKey && serviceRoleKey),
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    restUrl: `${supabaseUrl}/rest/v1`,
  }
}

export async function prepareAndStoreAuthorizedReportPdf(
  config: ReportPdfStorageConfig,
  token: string,
  reportId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PreparedReportPdfResult> {
  if (!config.enabled) {
    throw new ReportPdfStorageError(503, "Report storage is not configured.")
  }

  const bundle = await loadAuthorizedReportBundle(config as ReportBundleConfig, token, reportId, fetchImpl)
  if (
    !bundle.report.snapshot ||
    bundle.report.snapshotVersion < 1 ||
    bundle.report.snapshot.version !== bundle.report.snapshotVersion ||
    bundle.report.status !== "ready" ||
    bundle.report.staleAt ||
    bundle.report.readiness.snapshotCurrent === false ||
    !reportBundleSnapshotIsCurrent(bundle)
  ) {
    throw new ReportPdfStorageError(409, "Report evidence changed. Refresh and review the report before preparing a PDF.")
  }
  const viewModel = createBundleViewModel(bundle)
  const pdfBuffer = await renderReportPdfBuffer(viewModel)
  const pdfStoragePath = createReportPdfStoragePath(
    bundle.report.agencyId,
    bundle.report.id,
    bundle.report.snapshotVersion
  )

  const storageResponse = await fetchImpl(
    `${config.supabaseUrl}/storage/v1/object/${REPORT_PDF_BUCKET}/${encodeStorageObjectPath(pdfStoragePath)}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/pdf",
        "Cache-Control": "private, max-age=0, must-revalidate",
        "x-upsert": "false",
      },
      body: pdfBuffer,
    }
  )

  if (!storageResponse.ok) {
    const message = await storageResponse.text().catch(() => "")
    throw new ReportPdfStorageError(storageResponse.status || 502, message || "Could not store the private report PDF.")
  }

  const updatedAt = new Date().toISOString()
  const readiness = { ...bundle.report.readiness, pdfGenerated: true }
  const patchParams = new URLSearchParams({
    id: `eq.${bundle.report.id}`,
    snapshot_version: `eq.${bundle.report.snapshotVersion}`,
    evidence_fingerprint: `eq.${bundle.report.evidenceFingerprint}`,
    status: "eq.ready",
    stale_at: "is.null",
    select: "id,snapshot_version,pdf_snapshot_version",
  })
  const patchResponse = await fetchImpl(`${config.restUrl}/reports?${patchParams.toString()}`, {
    method: "PATCH",
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      readiness_json: readiness,
      pdf_storage_path: pdfStoragePath,
      pdf_snapshot_version: bundle.report.snapshotVersion,
      updated_at: updatedAt,
    }),
  })

  if (!patchResponse.ok) {
    throw new ReportPdfStorageError(502, "Report PDF was stored, but the report record could not be updated.")
  }
  const updatedRows = (await patchResponse.json().catch(() => [])) as Array<{
    id?: string
    snapshot_version?: number
    pdf_snapshot_version?: number | null
  }>
  if (
    updatedRows.length !== 1 ||
    Number(updatedRows[0].snapshot_version) !== bundle.report.snapshotVersion ||
    Number(updatedRows[0].pdf_snapshot_version) !== bundle.report.snapshotVersion
  ) {
    throw new ReportPdfStorageError(409, "Report evidence changed while the PDF was being prepared. Refresh and try again.")
  }

  return { pdfStoragePath, status: bundle.report.status, updatedAt }
}
