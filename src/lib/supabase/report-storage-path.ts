export const REPORT_PDF_BUCKET = "maintainflow-reports"

export function createReportPdfStoragePath(agencyId: string, reportId: string, snapshotVersion: number) {
  if (!Number.isInteger(snapshotVersion) || snapshotVersion < 1) {
    throw new Error("A positive report snapshot version is required for PDF storage.")
  }
  return `${agencyId}/reports/${reportId}/snapshot-${snapshotVersion}.pdf`
}

export function isExpectedReportPdfStoragePath(path: string, agencyId: string, reportId: string, snapshotVersion: number) {
  return path === createReportPdfStoragePath(agencyId, reportId, snapshotVersion)
}

export function encodeStorageObjectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/")
}
