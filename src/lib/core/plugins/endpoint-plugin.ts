import { calculateCheckStatus, evaluateAssertions } from "../assertions.ts"
import { syntheticDemoEndpointAllowed, validateEndpointUrlForRequest } from "../endpoint-safety.server.ts"
import { safeResponseSummary } from "../security.ts"
import { pinnedEndpointFetch } from "../pinned-http.server.ts"
import type { EndpointTestInput, EndpointTestResult, WorkflowMethod } from "../types.ts"
import { normalizeEndpointResult } from "./endpoint-result.ts"
import type { CheckPlugin, CheckPluginRunOptions } from "./types.ts"

const maxResponseBytes = 128_000
const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

export const endpointPlugin: CheckPlugin<EndpointTestInput, EndpointTestResult> = {
  pluginId: "endpoint",
  displayName: "Endpoint health check",
  configSchema: {
    type: "object",
    required: ["url", "method", "expectedStatus", "timeoutSeconds", "maxLatencyMs", "assertions"],
  },
  validateConfig(input: unknown) {
    const value = input as Partial<EndpointTestInput>
    const method = String(value.method ?? "GET").toUpperCase()
    if (!allowedMethods.has(method)) {
      throw new Error("Unsupported HTTP method.")
    }

    return {
      rateLimitKey: String(value.rateLimitKey ?? ""),
      url: String(value.url ?? ""),
      method: method as WorkflowMethod,
      headers: normalizeHeaders(value.headers),
      body: String(value.body ?? ""),
      expectedStatus: numberInRange(value.expectedStatus, 100, 599, 200),
      timeoutSeconds: numberInRange(value.timeoutSeconds, 1, 30, 10),
      maxLatencyMs: numberInRange(value.maxLatencyMs, 100, 60_000, 5_000),
      assertions: Array.isArray(value.assertions) ? value.assertions : [],
    }
  },
  run(config, options) {
    return runEndpointPluginCheck(config, options)
  },
  normalizeResult(result, config) {
    return normalizeEndpointResult(result, config)
  },
}

async function runEndpointPluginCheck(input: EndpointTestInput, options: CheckPluginRunOptions = {}): Promise<EndpointTestResult> {
  if (input.assertions.some((assertion) => assertion.enabled && assertion.type === "regex_match")) {
    return inconclusiveResult("Regex assertions are disabled until a non-backtracking engine is available.")
  }

  const safety = await validateEndpointUrlForRequest(input.url, options.resolveHostname, {
    allowSyntheticDemo: options.allowSyntheticDemo,
  })
  if (!safety.ok) {
    return inconclusiveResult(safety.reason)
  }

  if (safety.url.hostname === "demo.maintainflow.test") {
    if (!(options.allowSyntheticDemo ?? syntheticDemoEndpointAllowed())) {
      return inconclusiveResult("Synthetic demo endpoints are disabled in production.")
    }
    return demoResult(safety.url, input)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000)
  const started = Date.now()

  try {
    const requestInit: RequestInit = {
      method: input.method,
      headers: input.headers,
      body: input.method === "GET" ? undefined : input.body || undefined,
      redirect: "manual",
      signal: controller.signal,
    }
    const response = options.fetchImpl
      ? await options.fetchImpl(safety.url, requestInit)
      : await (options.pinnedFetchImpl ?? pinnedEndpointFetch)(safety.url, safety.addresses, requestInit)

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const redirectTarget = response.headers.get("location")
      if (!redirectTarget) {
        return inconclusiveResult("Endpoint redirects without a Location header, so the test could not reach a conclusive outcome.")
      }
      const redirectUrl = new URL(redirectTarget, safety.url)
      const redirectSafety = await validateEndpointUrlForRequest(redirectUrl.toString(), options.resolveHostname)
      if (!redirectSafety.ok) {
        return inconclusiveResult(`Redirect blocked: ${redirectSafety.reason}`)
      }
      return inconclusiveResult("Endpoint redirects. Follow-up redirect execution is deferred to avoid unsafe redirect chains.")
    }

    const latencyMs = Date.now() - started
    const contentType = response.headers.get("content-type") ?? "text/plain"
    const text = await readLimitedResponse(response)
    const assertionResults = evaluateAssertions(input.assertions, {
      responseText: text,
      statusCode: response.status,
      latencyMs,
    })
    const errorMessage =
      response.status === input.expectedStatus
        ? ""
        : `Expected HTTP ${input.expectedStatus} but received HTTP ${response.status}.`
    const status = calculateCheckStatus({
      expectedStatus: input.expectedStatus,
      statusCode: response.status,
      latencyMs,
      maxLatencyMs: input.maxLatencyMs,
      assertionResults,
      errorMessage,
    })

    return {
      status,
      statusCode: response.status,
      latencyMs,
      assertionResults,
      safeResponseSummary: safeResponseSummary(text, contentType),
      errorMessage,
    }
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `Timed out after ${input.timeoutSeconds} seconds.`
      : error instanceof Error && error.message === "Response was larger than the 128 KB safety cap."
        ? error.message
        : "Endpoint request failed before a conclusive response was received."
    return inconclusiveResult(message)
  } finally {
    clearTimeout(timeout)
  }
}

async function readLimitedResponse(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) {
    return ""
  }

  const chunks: Uint8Array[] = []
  let size = 0

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    size += value.length
    if (size > maxResponseBytes) {
      throw new Error("Response was larger than the 128 KB safety cap.")
    }

    chunks.push(value)
  }

  return new TextDecoder().decode(concat(chunks, size))
}

function concat(chunks: Uint8Array[], totalLength: number) {
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function inconclusiveResult(errorMessage: string): EndpointTestResult {
  return {
    status: "skipped",
    statusCode: null,
    latencyMs: null,
    assertionResults: [],
    safeResponseSummary: "No response body was stored.",
    errorMessage,
  }
}

function demoResult(url: URL, input: EndpointTestInput): EndpointTestResult {
  const failed = url.pathname.includes("failed") || url.searchParams.get("status") === "failed"
  const degraded = url.pathname.includes("degraded") || url.searchParams.get("status") === "degraded"
  const statusCode = failed ? 500 : 200
  const latencyMs = degraded ? input.maxLatencyMs + 350 : 142
  const responseText = failed
    ? JSON.stringify({ ok: false, error: "Demo upstream returned 500" })
    : JSON.stringify({ ok: true, workflow: "demo", maintained: true })
  const assertionResults = evaluateAssertions(input.assertions, { responseText, statusCode, latencyMs })
  const errorMessage = statusCode === input.expectedStatus ? "" : `Expected ${input.expectedStatus} but received ${statusCode}.`
  const status = calculateCheckStatus({
    expectedStatus: input.expectedStatus,
    statusCode,
    latencyMs,
    maxLatencyMs: input.maxLatencyMs,
    assertionResults,
    errorMessage,
  })

  return {
    status,
    statusCode,
    latencyMs,
    assertionResults,
    safeResponseSummary: safeResponseSummary(responseText, "application/json"),
    errorMessage,
  }
}

function normalizeHeaders(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, headerValue]) =>
        key.trim()
        && typeof headerValue === "string"
        && !["host", "connection", "content-length", "transfer-encoding", "proxy-authorization"].includes(key.trim().toLowerCase())
      )
      .map(([key, headerValue]) => [key.trim(), headerValue])
  ) as Record<string, string>
}

function numberInRange(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.min(max, Math.max(min, number))
}
