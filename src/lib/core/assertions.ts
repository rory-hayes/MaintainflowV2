import type { AssertionConfig, AssertionResult, CheckStatus } from "./types.ts"

type AssertionInput = {
  responseText: string
  statusCode: number | null
  latencyMs: number | null
}

export function evaluateAssertions(assertions: AssertionConfig[], input: AssertionInput): AssertionResult[] {
  const activeAssertions = assertions.filter((assertion) => assertion.enabled)

  return activeAssertions.map((assertion) => {
    if (assertion.type === "response_exists") {
      const passed = input.responseText.trim().length > 0
      return result(assertion, "Response exists", passed, passed ? "response present" : "empty response")
    }

    if (assertion.type === "text_contains") {
      const expected = assertion.expected ?? ""
      const passed = input.responseText.includes(expected)
      return result(assertion, `Text contains "${expected}"`, passed, input.responseText.slice(0, 120), expected)
    }

    if (assertion.type === "text_not_contains") {
      const expected = assertion.expected ?? ""
      const passed = !input.responseText.includes(expected)
      return result(assertion, `Text excludes "${expected}"`, passed, input.responseText.slice(0, 120), expected)
    }

    if (assertion.type === "regex_match") {
      const pattern = assertion.pattern || assertion.expected || ""
      return result(
        assertion,
        "Regex assertion disabled",
        false,
        undefined,
        pattern,
        "Regex assertions are disabled until a non-backtracking engine is available."
      )
    }

    const json = safeJson(input.responseText)
    if (!json.ok) {
      return result(assertion, assertionLabel(assertion), false, "non-json response", assertion.expected, "Response is not valid JSON.")
    }

    const actual = readJsonPath(json.value, assertion.path ?? "")

    if (assertion.type === "json_field_exists") {
      const passed = actual !== undefined
      return result(assertion, `JSON field exists: ${assertion.path}`, passed, stringifyActual(actual))
    }

    const expected = assertion.expected ?? ""
    const passed = String(actual) === expected
    return result(assertion, `JSON field equals: ${assertion.path}`, passed, stringifyActual(actual), expected)
  })
}

export function sanitizeAssertionResults(value: unknown): AssertionResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || !("passed" in item) || typeof item.passed !== "boolean") {
      return []
    }
    return [{
      id: `assertion-${index + 1}`,
      label: item.passed ? "Assertion passed" : "Assertion failed",
      passed: item.passed,
      ...(!item.passed ? { reason: "Assertion did not meet the configured condition." } : {}),
    }]
  })
}

export function isSafeRegexPattern(pattern: string): boolean {
  void pattern
  return false
}

export function calculateCheckStatus({
  expectedStatus,
  statusCode,
  latencyMs,
  maxLatencyMs,
  assertionResults,
  errorMessage,
}: {
  expectedStatus: number
  statusCode: number | null
  latencyMs: number | null
  maxLatencyMs: number
  assertionResults: AssertionResult[]
  errorMessage: string
}): CheckStatus {
  if (errorMessage || statusCode === null) {
    return "failed"
  }

  if (statusCode !== expectedStatus) {
    return statusCode >= 500 ? "failed" : "degraded"
  }

  if (latencyMs !== null && latencyMs > maxLatencyMs) {
    return "degraded"
  }

  if (assertionResults.some((assertion) => !assertion.passed)) {
    return "degraded"
  }

  return "healthy"
}

function result(
  assertion: AssertionConfig,
  _label: string,
  passed: boolean,
  _actual?: string,
  _expected?: string,
  reason?: string
): AssertionResult {
  void _label
  void _actual
  void _expected
  return {
    id: assertion.id,
    label: passed ? "Assertion passed" : "Assertion failed",
    passed,
    ...(!passed ? { reason: reason || "Assertion did not meet the configured condition." } : {}),
  }
}

function assertionLabel(assertion: AssertionConfig) {
  if (assertion.path) {
    return `JSON assertion: ${assertion.path}`
  }

  return assertion.type.replaceAll("_", " ")
}

function safeJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch {
    return { ok: false }
  }
}

function readJsonPath(value: unknown, path: string) {
  if (!path) {
    return value
  }

  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment]
    }

    return undefined
  }, value)
}

function stringifyActual(value: unknown) {
  if (value === undefined) {
    return "missing"
  }

  if (typeof value === "string") {
    return value
  }

  return JSON.stringify(value)
}
