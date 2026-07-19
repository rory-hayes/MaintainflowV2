import { createHash, createHmac, randomBytes } from "node:crypto"

export function createReportShareToken() {
  return randomBytes(32).toString("base64url")
}

export function deriveIdempotentReportShareToken(input: {
  reportId: string
  idempotencyKey: string
  expiresInHours: number
  pepper: string
}) {
  if (input.pepper.trim().length < 32) throw new Error("REPORT_SHARE_TOKEN_PEPPER must contain at least 32 characters.")
  if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > 24 * 90) {
    throw new Error("Report links may expire between one hour and 90 days.")
  }
  return createHmac("sha256", input.pepper)
    .update(`report:${input.reportId}:expires-hours:${input.expiresInHours}:idempotency:${input.idempotencyKey}`)
    .digest("base64url")
}

export function hashReportShareToken(token: string, pepper: string) {
  if (pepper.trim().length < 32) throw new Error("REPORT_SHARE_TOKEN_PEPPER must contain at least 32 characters.")
  if (!isReportShareToken(token)) throw new Error("The report share token is malformed.")
  return createHash("sha256").update(`${pepper}:${token}`).digest("hex")
}

export function isReportShareToken(token: string) {
  return /^[A-Za-z0-9_-]{32,100}$/.test(token)
}

export function hashReportSnapshot(snapshot: unknown) {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex")
}

export function reportShareExpiry(expiresInHours: number, nowMs = Date.now()) {
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 24 * 90) {
    throw new Error("Report links may expire between one hour and 90 days.")
  }
  return new Date(nowMs + expiresInHours * 60 * 60_000).toISOString()
}

export function redactSharedReportSnapshot<T>(snapshot: T): T {
  return deepRedact(snapshot) as T
}

/**
 * Returns only screenshot identifiers already present in the explicit public
 * report projection. Deliberately do not recurse through the source snapshot:
 * a future private field must never become evidence-download authority.
 */
export function reportSafeScreenshotIds(reportSafeProjection: unknown) {
  const ids = new Set<string>()
  const report = asRecord(reportSafeProjection)
  for (const run of asRecords(report.evidenceSummaries)) {
    for (const stage of asRecords(run.stages)) {
      for (const artifact of asRecords(stage.artifacts)) {
        if (
          artifact.kind === "screenshot"
          && (artifact.mimeType === "image/png" || artifact.mimeType === "image/jpeg")
          && typeof artifact.artifactId === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifact.artifactId)
        ) ids.add(artifact.artifactId)
      }
    }
  }
  return ids
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedact)
  if (!value || typeof value !== "object") return value

  const blockedKeys = new Set([
    "trace",
    "traceUrl",
    "dom",
    "domSummary",
    "network",
    "networkSummary",
    "rawEmail",
    "emailBody",
    "verificationLink",
    "verificationLinkCiphertext",
    "headers",
    "credentials",
    "storagePath",
    "signedUrl",
  ])

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !blockedKeys.has(key))
      .map(([key, item]) => [key, deepRedact(item)])
  )
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (!value || typeof value !== "object") return "null"
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}
