import { createFixedWindowRateLimiter } from "@/lib/core/rate-limit"
import { scanUrlSuggestions } from "@/lib/core/url-scan"
import { bearerToken } from "@/lib/supabase/report-download.server"
import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "@/lib/supabase/user-auth"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const urlScanLimiter = createFixedWindowRateLimiter({ limit: 20, windowMs: 60_000 })

export async function POST(request: NextRequest) {
  try {
    const auth = await urlScanAuth(request)
    if (!auth.ok) {
      return NextResponse.json({ baseUrl: "", suggestions: [], warnings: [auth.message] }, { status: 401 })
    }

    const limiterKey = auth.rateLimitKey || request.headers.get("x-forwarded-for") || "anonymous"
    const limit = urlScanLimiter.check(limiterKey)
    if (!limit.allowed) {
      return NextResponse.json(
        { baseUrl: "", suggestions: [], warnings: [`Too many URL scans. Try again after ${new Date(limit.resetAt).toISOString()}.`] },
        { status: 429 }
      )
    }

    const body = await request.json()
    const result = await scanUrlSuggestions({
      clientName: String(body?.clientName ?? ""),
      websiteUrl: String(body?.websiteUrl ?? ""),
      healthApiUrl: typeof body?.healthApiUrl === "string" ? body.healthApiUrl : undefined,
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      {
        baseUrl: "",
        suggestions: [],
        warnings: [error instanceof Error ? error.message : "URL scan failed."],
      },
      { status: 400 }
    )
  }
}

async function urlScanAuth(request: NextRequest) {
  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    return { ok: true as const, rateLimitKey: "", userId: null }
  }

  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return { ok: false as const, message: "Sign in before scanning a URL." }
  }

  try {
    const user = await verifySupabaseAccessToken(token, config)
    return { ok: true as const, rateLimitKey: user.id, userId: user.id }
  } catch (error) {
    return {
      ok: false as const,
      message: error instanceof Error ? error.message : "Sign in again before scanning a URL.",
    }
  }
}
