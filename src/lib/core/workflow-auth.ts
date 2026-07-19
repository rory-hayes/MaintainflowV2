import {
  isSafeSavedMonitorHeaderName,
  isSafeSavedMonitorHeaderValue,
  normalizeSafeSavedMonitorHeaders,
} from "./saved-monitor-policy.ts"

export type StoredWorkflowHeader = {
  key: string
  valuePreview: string
  sensitive: boolean
}

export function isSensitiveWorkflowHeader(key: string) {
  return !isSafeSavedMonitorHeaderName(key)
}

export function hasSensitiveWorkflowHeaders(headers: Record<string, string>) {
  return Object.keys(headers).some(isSensitiveWorkflowHeader)
}

export function storedWorkflowHeaders(headers: Record<string, string>): StoredWorkflowHeader[] {
  return Object.entries(normalizeSafeSavedMonitorHeaders(headers)).map(([key, value]) => ({
    key,
    valuePreview: value,
    sensitive: false,
  }))
}

export function sanitizeStoredWorkflowHeaders(value: unknown): StoredWorkflowHeader[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((header) => {
    if (
      !header ||
      typeof header !== "object" ||
      !("key" in header) ||
      !("valuePreview" in header) ||
      !("sensitive" in header) ||
      typeof header.key !== "string" ||
      typeof header.valuePreview !== "string" ||
      typeof header.sensitive !== "boolean"
    ) {
      return []
    }
    const key = header.key.trim()
    const valuePreview = header.valuePreview.trim()
    if (
      header.sensitive !== false
      || !isSafeSavedMonitorHeaderName(key)
      || !isSafeSavedMonitorHeaderValue(valuePreview)
    ) {
      return []
    }
    return [{ key, valuePreview, sensitive: false }]
  })
}

export function scheduledHeadersFromWorkflowConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("headers" in value)) {
    return {}
  }

  const headers = sanitizeStoredWorkflowHeaders((value as { headers?: unknown }).headers)

  return Object.fromEntries(
    headers
      .filter((header) => !header.sensitive)
      .map((header) => [header.key, header.valuePreview])
  )
}
