import { encodeStorageObjectPath, isExpectedReportPdfStoragePath, REPORT_PDF_BUCKET } from "./report-storage-path.ts"
import { loadAuthorizedReportBundle, reportBundleSnapshotIsCurrent } from "./report-bundle.server.ts"

type ReportRow = {
  id: string
  agency_id: string
  client_id: string
  status: string
  snapshot_version: number
  snapshot_json: Record<string, unknown> | null
  evidence_fingerprint: string
  stale_at: string | null
  readiness_json: Record<string, boolean> | null
  pdf_storage_path: string | null
  pdf_snapshot_version: number | null
}

export type ReportDownloadConfig = ReturnType<typeof getReportDownloadConfig>
type ReportDownloadEnv = {
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type ReportDownloadResult = {
  status: number
  body: BodyInit | null
  contentType?: string
  filename?: string
}

export function getReportDownloadConfig(env?: ReportDownloadEnv) {
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

export async function loadAuthorizedReport(
  config: ReportDownloadConfig,
  token: string,
  reportId: string,
  fetchImpl: typeof fetch = fetch
) {
  const params = new URLSearchParams({
    select: "id,agency_id,client_id,status,snapshot_version,snapshot_json,evidence_fingerprint,stale_at,readiness_json,pdf_storage_path,pdf_snapshot_version",
    id: `eq.${reportId}`,
    limit: "1",
  })
  const response = await fetchImpl(`${config.restUrl}/reports?${params.toString()}`, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error("Could not authorize the report download.")
  }

  const rows = (await response.json().catch(() => [])) as ReportRow[]
  return rows[0] ?? null
}

export async function loadAuthorizedReportPdf(
  config: ReportDownloadConfig,
  token: string,
  reportId: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReportDownloadResult> {
  const bundle = await loadAuthorizedReportBundle(config, token, reportId, fetchImpl).catch((error) => {
    if (error && typeof error === "object" && "status" in error && Number(error.status) === 404) return null
    throw error
  })
  const report = bundle?.report
  if (!report) {
    return { status: 404, body: "Report PDF has not been prepared." }
  }

  if (
    !report.snapshot ||
    report.snapshotVersion < 1 ||
    report.snapshot.version !== report.snapshotVersion ||
    report.snapshot.evidenceFingerprint !== report.evidenceFingerprint ||
    !["ready", "sent"].includes(report.status) ||
    report.staleAt ||
    report.readiness.snapshotCurrent === false ||
    !bundle ||
    !reportBundleSnapshotIsCurrent(bundle)
  ) {
    return { status: 409, body: "Report evidence changed. Refresh and prepare a current PDF before downloading." }
  }

  if (!report.pdfStoragePath || report.pdfSnapshotVersion === null) {
    return { status: 404, body: "Report PDF has not been prepared." }
  }

  if (report.pdfSnapshotVersion !== report.snapshotVersion) {
    return { status: 409, body: "Prepared PDF does not match the current report evidence." }
  }

  if (!isExpectedReportPdfStoragePath(report.pdfStoragePath, report.agencyId, report.id, report.snapshotVersion)) {
    return { status: 409, body: "Stored report path does not match the authorized report." }
  }

  const storageResponse = await fetchImpl(
    `${config.supabaseUrl}/storage/v1/object/${REPORT_PDF_BUCKET}/${encodeStorageObjectPath(report.pdfStoragePath)}`,
    {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    }
  )

  if (!storageResponse.ok || !storageResponse.body) {
    return { status: storageResponse.status || 404, body: "Report PDF could not be loaded." }
  }

  const confirmed = await loadAuthorizedReport(config, token, reportId, fetchImpl)
  if (
    !confirmed ||
    confirmed.status !== report.status ||
    Number(confirmed.snapshot_version) !== report.snapshotVersion ||
    Number(confirmed.pdf_snapshot_version) !== report.pdfSnapshotVersion ||
    confirmed.evidence_fingerprint !== report.evidenceFingerprint ||
    confirmed.stale_at ||
    confirmed.pdf_storage_path !== report.pdfStoragePath
  ) {
    return { status: 409, body: "Report evidence changed during download. Refresh and try again." }
  }

  return {
    status: 200,
    body: storageResponse.body,
    contentType: storageResponse.headers.get("content-type") ?? "application/pdf",
    filename: `${report.clientId}-maintain-flow-report.pdf`,
  }
}

export function bearerToken(header: string | null) {
  if (!header?.startsWith("Bearer ")) {
    return null
  }

  const token = header.slice("Bearer ".length).trim()
  return token || null
}
