import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { journeyDraftSchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { getJourney, updateJourneyDraft } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    return NextResponse.json({ ok: true, data: await getJourney(auth.workspace.id, assertUuid(id, "journey ID")) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, journeyDraftSchema)
    return NextResponse.json({ ok: true, data: await updateJourneyDraft(auth.workspace.id, assertUuid(id, "journey ID"), input) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
