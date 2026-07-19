import type { EndpointTestInput, EndpointTestResult } from "../types.ts"
import type { NormalizedCheckResult } from "./types.ts"

export function normalizeEndpointResult(
  result: EndpointTestResult,
  config?: Pick<EndpointTestInput, "url" | "expectedStatus" | "maxLatencyMs">
): NormalizedCheckResult {
  const failedAssertion = result.assertionResults.find((assertion) => !assertion.passed)
  const status = result.status === "failed" ? "unhealthy" : result.status
  const issueReason = result.errorMessage || failedAssertion?.label || result.status

  return {
    status,
    durationMs: result.latencyMs,
    summary: result.errorMessage || result.safeResponseSummary || `Endpoint returned ${result.status}.`,
    evidence: {
      pluginId: "endpoint",
      statusCode: result.statusCode,
      expectedStatus: config?.expectedStatus ?? null,
      maxLatencyMs: config?.maxLatencyMs ?? null,
      assertionCount: result.assertionResults.length,
      failedAssertionCount: result.assertionResults.filter((assertion) => !assertion.passed).length,
    },
    assertionResults: result.assertionResults,
    issueFingerprint: `endpoint:${result.statusCode ?? "no-status"}:${issueReason}`,
    reportSafeSummary: result.safeResponseSummary || result.errorMessage || "No report-safe response summary was stored.",
  }
}
