import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { journeyPublishSchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { publishJourney } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, journeyPublishSchema)
    const data = await publishJourney({
      agencyId: auth.workspace.id,
      journeyId: assertUuid(id, "journey ID"),
      userId: auth.user.id,
      ...input,
    })
    return NextResponse.json({ ok: true, data })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
