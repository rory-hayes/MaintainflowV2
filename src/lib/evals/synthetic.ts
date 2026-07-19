const sensitiveKey = /(?:password|passcode|secret|token|api[_-]?key|authorization|cookie|session|credential)/i
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const phonePattern = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/g

export function syntheticMarker(runId: string) {
  const normalized = runId.replace(/-/g, "").toUpperCase()
  if (!/^[A-F0-9]{20,64}$/.test(normalized)) {
    throw new Error("A stable hexadecimal run identifier is required for synthetic data.")
  }
  return `MF-EVAL-${normalized.slice(0, 20)}`
}

export function syntheticEmail(marker: string, domain = "evals.maintainflow.test") {
  if (!isSyntheticMarker(marker)) throw new Error("A valid Maintain Flow synthetic marker is required.")
  if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes(".")) throw new Error("A valid synthetic email domain is required.")
  return `${marker}@${domain}`
}

export function isSyntheticMarker(value: unknown): value is string {
  return typeof value === "string" && /^MF-EVAL-[A-F0-9]{20}$/.test(value)
}

export function redactSensitiveText(value: string) {
  return value
    .replace(bearerPattern, "Bearer [REDACTED]")
    .replace(emailPattern, "[REDACTED_EMAIL]")
    .replace(phonePattern, "[REDACTED_PHONE]")
}

export function redactSensitiveValue<T>(value: T): T {
  return redact(value, new WeakSet<object>()) as T
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[REDACTED_CYCLE]"
  seen.add(value)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    sensitiveKey.test(key) ? "[REDACTED]" : redact(nested, seen),
  ]))
}
