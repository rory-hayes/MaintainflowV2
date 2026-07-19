import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { getJourneyForwardingAddress } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const data = await getJourneyForwardingAddress(auth.workspace.id, assertUuid(id, "journey ID"))
    return NextResponse.json({ ok: true, data }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
