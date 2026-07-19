import { normalizeProductEvent } from "@/lib/analytics/product-events.shared"
import { bearerToken } from "@/lib/supabase/report-download.server"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "@/lib/supabase/user-auth"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type MembershipRow = {
  agency_id: string
}

export async function POST(request: NextRequest) {
  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    return NextResponse.json({ ok: true, skipped: "supabase-auth-not-configured" }, { status: 202 })
  }

  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  let user: { id: string; email: string }
  try {
    user = await verifySupabaseAccessToken(token, config)
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unauthorized" },
      { status: 401 }
    )
  }

  try {
    const input = normalizeProductEvent(await request.json().catch(() => ({})))
    if (!input.eventName) {
      return NextResponse.json({ ok: false, error: "Unknown analytics event." }, { status: 400 })
    }

    const agencyId = await authorizedAgencyId(user.id, input.agencyId)
    const { sessionId, ...metadata } = input.metadata
    await supabaseServiceJson("product_events", {
      method: "POST",
      body: JSON.stringify({
        agency_id: agencyId,
        user_id: user.id,
        event_name: input.eventName,
        route: input.route,
        session_id: typeof sessionId === "string" ? sessionId : "",
        metadata_json: metadata,
      }),
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Analytics event could not be stored.",
      },
      { status: 202 }
    )
  }
}

async function authorizedAgencyId(userId: string, agencyId: string | null) {
  if (!agencyId) return null

  const memberships = await supabaseServiceJson<MembershipRow[]>(
    `memberships?select=agency_id&user_id=eq.${encodeURIComponent(userId)}&agency_id=eq.${encodeURIComponent(agencyId)}&limit=1`
  )

  return memberships[0]?.agency_id ?? null
}
