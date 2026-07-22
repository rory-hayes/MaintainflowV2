export const REPORT_PDF_BUCKET = "maintainflow-reports"

export type ReportPdfBranding = "maintain_flow" | "white_label"

export function createReportPdfStoragePath(
  agencyId: string,
  reportId: string,
  snapshotVersion: number,
  branding: ReportPdfBranding = "maintain_flow",
) {
  if (!Number.isInteger(snapshotVersion) || snapshotVersion < 1) {
    throw new Error("A positive report snapshot version is required for PDF storage.")
  }
  const suffix = branding === "white_label" ? "-white-label" : ""
  return `${agencyId}/reports/${reportId}/snapshot-${snapshotVersion}${suffix}.pdf`
}

export function isExpectedReportPdfStoragePath(
  path: string,
  agencyId: string,
  reportId: string,
  snapshotVersion: number,
  branding: ReportPdfBranding = "maintain_flow",
) {
  return path === createReportPdfStoragePath(agencyId, reportId, snapshotVersion, branding)
}

export function encodeStorageObjectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/")
}
