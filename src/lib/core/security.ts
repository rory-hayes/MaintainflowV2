const blockedHostnames = new Set(["localhost", "0.0.0.0", "metadata.google.internal"])
const blockedExactIps = new Set(["127.0.0.1", "::1", "169.254.169.254"])

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

export function validateEndpointUrl(input: string): UrlSafetyResult {
  let parsed: URL

  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, reason: "Enter a valid absolute http or https URL." }
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: "Only http and https endpoint URLs are allowed." }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Do not embed credentials in the URL. Add auth headers instead." }
  }

  const hostname = parsed.hostname.toLowerCase()

  if (blockedHostnames.has(hostname) || blockedExactIps.has(hostname)) {
    return { ok: false, reason: "Localhost, metadata, and loopback targets are blocked." }
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return { ok: false, reason: "Private, link-local, and internal IP ranges are blocked." }
  }

  return { ok: true, url: parsed }
}

export function assertSafeEndpointUrl(input: string) {
  const result = validateEndpointUrl(input)
  if (!result.ok) {
    throw new Error(result.reason)
  }

  return result.url
}

export function safeResponseSummary(text: string, contentType: string) {
  const prefix = contentType.includes("json") ? "JSON" : contentType.includes("html") ? "HTML" : "Text"
  if (!text) {
    return `${prefix} response was empty.`
  }

  const bytes = new TextEncoder().encode(text).byteLength
  return `${prefix} response received (${bytes} bytes); body content was not stored.`
}

export function maskSecret(value: string) {
  if (!value) {
    return ""
  }

  if (value.length <= 8) {
    return "••••"
  }

  return `${value.slice(0, 3)}••••${value.slice(-3)}`
}

export function redactSecrets(value: string) {
  return value
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[a-z0-9._~+/=-]+/gi, "$1$2[redacted]")
    .replace(/(api[-_ ]?key\s*[:=]\s*)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(token\s*[:=]\s*)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
}

function isPrivateIpv4(hostname: string) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return false
  }

  const parts = hostname.split(".").map(Number)
  if (parts.some((part) => part < 0 || part > 255)) {
    return true
  }

  const [first, second] = parts
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    first === 0
  )
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  )
}
