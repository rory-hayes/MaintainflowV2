import { runEndpointTest } from "@/lib/core/check-runner"
import { createFixedWindowRateLimiter } from "@/lib/core/rate-limit"
import type { AssertionConfig, EndpointTestInput, WorkflowMethod } from "@/lib/core/types"
import { recordRateLimitEvent } from "@/lib/ops/rate-limit-events.server"
import { PersistedCheckError, runAndPersistAuthorizedCheck } from "@/lib/supabase/persisted-check.server"
import { bearerToken } from "@/lib/supabase/report-download.server"
import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "@/lib/supabase/user-auth"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])
const endpointTestLimiter = createFixedWindowRateLimiter({ limit: 30, windowMs: 60_000 })

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const auth = await endpointTestAuth(request)
    if (!auth.ok) {
      return endpointTestError(auth.message, 401)
    }

    const persistedCheckId = checkIdFromBody(body)
    const input = persistedCheckId ? null : normalizeInput(body)

    const limiterKey = auth.rateLimitKey || input?.rateLimitKey || request.headers.get("x-forwarded-for") || "anonymous"
    const limit = endpointTestLimiter.check(limiterKey)
    if (!limit.allowed) {
      recordEndpointRateLimit(limiterKey, auth.userId, null, input?.rateLimitKey, limit)
      return endpointTestError(`Too many endpoint tests. Try again after ${new Date(limit.resetAt).toISOString()}.`, 429)
    }

    if (persistedCheckId) {
      if (!auth.token) {
        return endpointTestError("Sign in before recording saved check evidence.", 401)
      }
      const result = await runAndPersistAuthorizedCheck(auth.token, persistedCheckId)
      recordEndpointRateLimit(limiterKey, auth.userId, result.agencyId, undefined, limit)
      return NextResponse.json(result)
    }

    recordEndpointRateLimit(limiterKey, auth.userId, null, input?.rateLimitKey, limit)
    const result = await runEndpointTest(input as EndpointTestInput)
    return NextResponse.json(result)
  } catch (error) {
    return endpointTestError(
      error instanceof Error ? error.message : "Check request was invalid.",
      error instanceof PersistedCheckError ? error.status : 400
    )
  }
}

async function endpointTestAuth(request: NextRequest) {
  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    return { ok: true as const, rateLimitKey: "", userId: null, token: null }
  }

  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return { ok: false as const, message: "Sign in before testing an endpoint." }
  }

  try {
    const user = await verifySupabaseAccessToken(token, config)
    return { ok: true as const, rateLimitKey: user.id, userId: user.id, token }
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Sign in again before testing an endpoint.",
    }
  }
}

function recordEndpointRateLimit(
  key: string,
  userId: string | null,
  persistedAgencyId: string | null,
  inputRateLimitKey: string | undefined,
  limit: { allowed: boolean; remaining: number; resetAt: number }
) {
  void recordRateLimitEvent({
    scope: "endpoint_test",
    key,
    userId,
    agencyId: persistedAgencyId ?? agencyIdFromRateLimitKey(inputRateLimitKey, userId),
    allowed: limit.allowed,
    remaining: limit.remaining,
    resetAt: new Date(limit.resetAt).toISOString(),
  })
}

function checkIdFromBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("checkId" in value)) {
    return ""
  }
  return String(value.checkId ?? "").trim()
}

function agencyIdFromRateLimitKey(value: string | undefined, userId: string | null) {
  if (!value || !userId) return null
  const [agencyId, keyUserId] = value.split(":")
  if (keyUserId !== userId) return null
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agencyId)
    ? agencyId
    : null
}

function endpointTestError(errorMessage: string, status: number) {
  return NextResponse.json(
    {
      status: "skipped",
      statusCode: null,
      latencyMs: null,
      assertionResults: [],
      safeResponseSummary: "No response body was stored.",
      errorMessage,
    },
    { status }
  )
}

function normalizeInput(value: unknown): EndpointTestInput {
  const input = value as Partial<EndpointTestInput>
  const method = String(input.method ?? "GET").toUpperCase()

  if (!allowedMethods.has(method)) {
    throw new Error("Unsupported HTTP method.")
  }

  return {
    rateLimitKey: String(input.rateLimitKey ?? ""),
    url: String(input.url ?? ""),
    method: method as WorkflowMethod,
    headers: normalizeHeaders(input.headers),
    body: String(input.body ?? ""),
    expectedStatus: numberInRange(input.expectedStatus, 100, 599, 200),
    timeoutSeconds: numberInRange(input.timeoutSeconds, 1, 30, 10),
    maxLatencyMs: numberInRange(input.maxLatencyMs, 100, 60_000, 5_000),
    assertions: normalizeAssertions(input.assertions),
  }
}

function normalizeHeaders(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, headerValue]) => key.trim() && typeof headerValue === "string")
      .map(([key, headerValue]) => [key.trim(), headerValue])
  ) as Record<string, string>
}

function normalizeAssertions(value: unknown): AssertionConfig[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is AssertionConfig => {
    return Boolean(item && typeof item === "object" && "id" in item && "type" in item)
  })
}

function numberInRange(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.min(max, Math.max(min, number))
}
