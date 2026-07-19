import { normalizePublicMarketingEvent } from "@/lib/analytics/public-marketing-events.shared"
import { createFixedWindowRateLimiter } from "@/lib/core/rate-limit"
import { siteUrl } from "@/lib/seo"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const maxBodyBytes = 1_024
const processLimiter = createFixedWindowRateLimiter({ limit: 600, windowMs: 10 * 60_000 })

export async function POST(request: NextRequest) {
  if (!isCanonicalProductionRequest(request)) return noContent()

  if (!isSameOriginBrowserRequest(request)) {
    return noStoreJson({ ok: false, error: "Forbidden" }, 403)
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return noStoreJson({ ok: false, error: "Unsupported content type" }, 415)
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return noStoreJson({ ok: false, error: "Request too large" }, 413)
  }

  const rawBody = await request.text().catch(() => "")
  if (new TextEncoder().encode(rawBody).byteLength > maxBodyBytes) {
    return noStoreJson({ ok: false, error: "Request too large" }, 413)
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return noStoreJson({ ok: false, error: "Invalid event" }, 400)
  }

  const event = normalizePublicMarketingEvent(body)
  if (!event) {
    return noStoreJson({ ok: false, error: "Invalid event" }, 400)
  }

  if (!processLimiter.check("public-marketing").allowed) return noContent()

  try {
    await supabaseServiceJson("rpc/record_public_acquisition_event", {
      method: "POST",
      signal: AbortSignal.timeout(2_000),
      body: JSON.stringify({
        p_event_name: event.eventName,
        p_route: event.route,
        p_placement: event.placement,
      }),
    })
  } catch {
    // Acquisition telemetry must never interrupt a buyer's navigation.
  }

  return noContent()
}

function isCanonicalProductionRequest(request: NextRequest) {
  return (
    process.env.PUBLIC_TELEMETRY_ENABLED === "true"
    && process.env.VERCEL_ENV === "production"
    && request.nextUrl.origin === new URL(siteUrl).origin
  )
}

function isSameOriginBrowserRequest(request: NextRequest) {
  const origin = request.headers.get("origin")
  if (!origin) return false

  let expectedOrigin = ""
  try {
    expectedOrigin = new URL(origin).origin
  } catch {
    return false
  }

  const fetchSite = request.headers.get("sec-fetch-site")
  return expectedOrigin === request.nextUrl.origin && (!fetchSite || fetchSite === "same-origin")
}

function noContent() {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } })
}

function noStoreJson(body: { ok: false; error: string }, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}
