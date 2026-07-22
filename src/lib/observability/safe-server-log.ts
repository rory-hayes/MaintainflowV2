type SafeServerLogLevel = "error" | "warn"
type SafeServerLogValue = string | number | boolean

const SAFE_EVENT = /^[a-z][a-z0-9-]{2,80}$/
const SAFE_FIELD = /^[a-z][a-zA-Z0-9]{0,40}$/
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,120}$/

export function safeServerLog(
  level: SafeServerLogLevel,
  event: string,
  fields: Record<string, SafeServerLogValue> = {},
) {
  const safeEvent = SAFE_EVENT.test(event) ? event : "server-event-invalid"
  const safeFields = Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => SAFE_FIELD.test(key))
      .map(([key, value]) => [key, safeLogValue(value)])
  )
  const write = level === "warn" ? console.warn : console.error
  write(`[${safeEvent}]`, safeFields)
}

function safeLogValue(value: SafeServerLogValue) {
  if (typeof value === "number") return Number.isFinite(value) ? value : "invalid"
  if (typeof value === "boolean") return value
  return SAFE_VALUE.test(value) ? value : "invalid"
}
