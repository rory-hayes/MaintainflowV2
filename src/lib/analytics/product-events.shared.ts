export const productEventNames = [
  "page_view",
  "signup_completed",
  "sign_up_completed",
  "sign_in_completed",
  "google_oauth_started",
  "oauth_completed",
  "signed_out",
  "workspace_created",
  "agency_profile_updated",
  "client_created",
  "first_client_created",
  "client_updated",
  "client_archived",
  "workflow_test_started",
  "workflow_test_succeeded",
  "workflow_test_inconclusive",
  "workflow_test_failed",
  "workflow_created",
  "first_workflow_created",
  "workflow_pending_created",
  "first_check_created",
  "check_run_started",
  "first_check_run",
  "check_run_completed",
  "scheduled_checks_run",
  "scheduled_checks_none_due",
  "issue_updated",
  "issue_resolved",
  "issue_repair_recorded",
  "issue_note_created",
  "report_generated",
  "first_report_previewed",
  "report_pdf_generated",
  "report_delivery_draft_copied",
  "report_narrative_updated",
  "checkout_clicked",
] as const

export type ProductEventName = (typeof productEventNames)[number]

export type ProductEventMetadata = Record<string, string | number | boolean | null>

const reportShareTokenPath = /\/share\/reports\/[^/?#\s"'<>]+/gi

export function isProductEventName(value: unknown): value is ProductEventName {
  return typeof value === "string" && productEventNames.includes(value as ProductEventName)
}

export function normalizeProductEvent(input: unknown) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const eventName = isProductEventName(value.eventName) ? value.eventName : null

  return {
    eventName,
    agencyId: normalizeOptionalUuid(value.agencyId),
    route: normalizeRoute(value.route),
    metadata: sanitizeProductEventMetadata(value.metadata),
  }
}

export function sanitizeProductEventMetadata(input: unknown): ProductEventMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .slice(0, 24)
      .map(([key, value]) => [safeMetadataKey(key), safeMetadataValue(value)] as const)
      .filter(([key]) => Boolean(key))
  )
}

function normalizeOptionalUuid(value: unknown) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : null
}

function normalizeRoute(value: unknown) {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (!trimmed.startsWith("/")) return ""
  return redactReportShareTokens(trimmed).slice(0, 180)
}

function safeMetadataKey(key: string) {
  return key.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 64)
}

function safeMetadataValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string") return redactReportShareTokens(value).slice(0, 240)
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value
  return null
}

function redactReportShareTokens(value: string) {
  return value.replace(reportShareTokenPath, "/share/reports/[token]")
}
