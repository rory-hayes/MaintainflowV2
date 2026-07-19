import type { AssertionConfig, WorkflowMethod } from "./types.ts"

// Until encrypted credential storage exists, the only honest persisted header
// contract is no custom headers. A name-only allowlist can still hide a token in
// an otherwise harmless value (for example Accept: <secret>).
export const savedMonitorHeaderAllowlist = new Set<string>()

const savedCheckConfigKeys = new Set([
  "expectedStatus",
  "timeoutSeconds",
  "maxLatencyMs",
])

const legacySavedCheckConfigKeys = new Set([
  ...savedCheckConfigKeys,
  "url",
  "method",
  "body",
  "assertionCount",
])

export type SavedMonitorInput = {
  endpointUrl: string
  method: WorkflowMethod | string
  headers: Record<string, string>
  requestBody: string
}

export type SavedMonitorPolicyOptions = {
  allowEmptyEndpoint?: boolean
}

export function savedMonitorPolicyViolation(
  input: SavedMonitorInput,
  options: SavedMonitorPolicyOptions = {},
) {
  const endpointViolation = savedMonitorEndpointViolation(
    input.endpointUrl,
    options.allowEmptyEndpoint === true,
  )
  if (endpointViolation) return endpointViolation

  if (String(input.method).toUpperCase() !== "GET") {
    return "Saved monitors currently support public GET endpoints only."
  }

  if (input.requestBody.trim()) {
    return "Request bodies cannot be stored for saved monitors. Use a public GET health endpoint."
  }

  try {
    normalizeSafeSavedMonitorHeaders(input.headers)
  } catch (error) {
    return error instanceof Error ? error.message : "Saved monitor headers are not allowed."
  }

  return null
}

export function assertSavedMonitorPolicy(
  input: SavedMonitorInput,
  options: SavedMonitorPolicyOptions = {},
) {
  const violation = savedMonitorPolicyViolation(input, options)
  if (violation) throw new Error(violation)

  return {
    endpointUrl: input.endpointUrl.trim(),
    method: "GET" as const,
    headers: normalizeSafeSavedMonitorHeaders(input.headers),
    requestBody: "",
  }
}

export function savedMonitorEndpointViolation(input: string, allowEmpty = false) {
  const value = input.trim()
  if (!value) {
    return allowEmpty ? null : "Enter a public HTTPS health endpoint before saving this monitor."
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "Enter a valid public HTTPS health endpoint."
  }

  if (url.protocol !== "https:") {
    return "Saved monitors require an HTTPS endpoint."
  }
  if (url.username || url.password) {
    return "Endpoint credentials cannot be stored in the URL."
  }
  if (url.search) {
    return "Saved monitor URLs cannot include query parameters. Use a credential-free health endpoint path."
  }
  if (url.hash) {
    return "Saved monitor URLs cannot include a fragment."
  }
  if (url.hostname.toLowerCase() === "demo.maintainflow.test") {
    return "The synthetic demo endpoint cannot be saved as customer evidence."
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (
    !hostname.includes(".")
    || hostname.endsWith(".")
    || hostname.includes(":")
    || /^[0-9.]+$/.test(hostname)
    || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)
    || hostname.endsWith(".home.arpa")
  ) {
    return "Saved monitors require a public DNS hostname; local and literal IP endpoints cannot be saved."
  }

  return null
}

export function isSafeSavedMonitorHeaderName(key: string) {
  return savedMonitorHeaderAllowlist.has(key.trim().toLowerCase())
}

export function isSafeSavedMonitorHeaderValue(value: string) {
  return value.length <= 256 && !/[\r\n]/.test(value)
}

export function normalizeSafeSavedMonitorHeaders(headers: Record<string, string>) {
  const normalized: Record<string, string> = {}
  const seen = new Set<string>()

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim()
    const lowerKey = key.toLowerCase()
    const value = rawValue.trim()
    if (!isSafeSavedMonitorHeaderName(key)) {
      throw new Error("Custom request headers cannot be stored for saved monitors yet.")
    }
    if (seen.has(lowerKey)) {
      throw new Error(`Saved monitor header ${key} is duplicated.`)
    }
    if (!isSafeSavedMonitorHeaderValue(value)) {
      throw new Error(`Saved monitor header ${key} has an invalid value.`)
    }
    seen.add(lowerKey)
    normalized[key] = value
  }

  return normalized
}

export function savedCheckConfigViolation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Saved check configuration must be an object."
  }

  const config = value as Record<string, unknown>
  const unexpectedKey = Object.keys(config).find((key) => !savedCheckConfigKeys.has(key))
  if (unexpectedKey) {
    return `Saved check configuration cannot override ${unexpectedKey}.`
  }

  const expectedStatus = optionalFiniteNumber(config.expectedStatus)
  if (expectedStatus !== null && (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599)) {
    return "Saved check expected status must be an HTTP status code."
  }
  const timeoutSeconds = optionalFiniteNumber(config.timeoutSeconds)
  if (timeoutSeconds !== null && (timeoutSeconds < 1 || timeoutSeconds > 30)) {
    return "Saved check timeout must be between 1 and 30 seconds."
  }
  const maxLatencyMs = optionalFiniteNumber(config.maxLatencyMs)
  if (maxLatencyMs !== null && (maxLatencyMs < 100 || maxLatencyMs > 60_000)) {
    return "Saved check latency threshold must be between 100 and 60000 milliseconds."
  }

  return null
}

export function assertSafeSavedCheckConfig(value: unknown) {
  const violation = savedCheckConfigViolation(value)
  if (violation) throw new Error(violation)
  return value as Record<string, unknown>
}

export function sanitizeSavedCheckConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const config = value as Record<string, unknown>
  const sanitized: Record<string, number> = {}

  const expectedStatus = optionalFiniteNumber(config.expectedStatus)
  if (expectedStatus !== null && Number.isInteger(expectedStatus) && expectedStatus >= 100 && expectedStatus <= 599) {
    sanitized.expectedStatus = expectedStatus
  }
  const timeoutSeconds = optionalFiniteNumber(config.timeoutSeconds)
  if (timeoutSeconds !== null && timeoutSeconds >= 1 && timeoutSeconds <= 30) {
    sanitized.timeoutSeconds = timeoutSeconds
  }
  const maxLatencyMs = optionalFiniteNumber(config.maxLatencyMs)
  if (maxLatencyMs !== null && maxLatencyMs >= 100 && maxLatencyMs <= 60_000) {
    sanitized.maxLatencyMs = maxLatencyMs
  }

  return sanitized
}

export function savedAssertionsViolation(value: unknown) {
  if (!Array.isArray(value)) return "Saved assertions must be an array."
  if (value.length > 10) return "Saved monitors support at most 10 structural assertions."

  for (const assertion of value) {
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
      return "Saved assertions must be objects."
    }
    const item = assertion as Record<string, unknown>
    if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.id)) {
      return "Saved assertion IDs must use 1 to 64 letters, numbers, dashes, or underscores."
    }
    if (typeof item.enabled !== "boolean") return "Saved assertions require an enabled flag."

    if (item.type === "response_exists") {
      if (Object.keys(item).some((key) => !["id", "type", "enabled"].includes(key))) {
        return "Response assertions cannot store values or patterns."
      }
      continue
    }
    if (item.type === "json_field_exists") {
      if (Object.keys(item).some((key) => !["id", "type", "path", "enabled"].includes(key))) {
        return "JSON field assertions cannot store expected values or patterns."
      }
      if (
        typeof item.path !== "string"
        || item.path.length > 128
        || !/^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/.test(item.path)
      ) {
        return "Saved JSON field paths must be short dot-separated field names."
      }
      continue
    }
    return "Saved monitors only support response-exists and JSON-field-exists assertions."
  }

  return null
}

export function assertSafeSavedAssertions(value: unknown): AssertionConfig[] {
  const violation = savedAssertionsViolation(value)
  if (violation) throw new Error(violation)
  return value as AssertionConfig[]
}

export function sanitizeSavedAssertions(value: unknown): AssertionConfig[] {
  if (!Array.isArray(value)) return []
  const sanitized: AssertionConfig[] = []
  for (const assertion of value.slice(0, 10)) {
    if (savedAssertionsViolation([assertion])) continue
    const item = assertion as AssertionConfig
    sanitized.push(item.type === "json_field_exists"
      ? { id: item.id, type: item.type, path: item.path, enabled: item.enabled }
      : { id: item.id, type: "response_exists", enabled: item.enabled })
  }
  return sanitized
}

export function savedCheckConfigForExecution(
  value: unknown,
  canonical: { endpointUrl: string; method: WorkflowMethod | string },
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Saved check configuration must be an object.")
  }
  const config = value as Record<string, unknown>
  const unexpectedKey = Object.keys(config).find((key) => !legacySavedCheckConfigKeys.has(key))
  if (unexpectedKey) {
    throw new Error(`Saved check configuration contains unsupported field ${unexpectedKey}.`)
  }
  if (config.url !== undefined) {
    if (typeof config.url !== "string" || config.url.trim() !== canonical.endpointUrl.trim()) {
      throw new Error("Legacy saved check URL does not match its workflow endpoint.")
    }
  }
  if (config.method !== undefined) {
    if (
      typeof config.method !== "string"
      || config.method.toUpperCase() !== String(canonical.method).toUpperCase()
    ) {
      throw new Error("Legacy saved check method does not match its workflow method.")
    }
  }
  if (config.body !== undefined) {
    if (typeof config.body !== "string" || config.body.trim()) {
      throw new Error("Legacy saved check request bodies cannot be executed.")
    }
  }
  if (
    config.assertionCount !== undefined
    && (typeof config.assertionCount !== "number" || !Number.isFinite(config.assertionCount))
  ) {
    throw new Error("Legacy saved check assertion metadata is invalid.")
  }

  return sanitizeSavedCheckConfig(config)
}

function optionalFiniteNumber(value: unknown) {
  if (value === undefined) return null
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN
}
