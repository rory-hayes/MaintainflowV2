import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { journeyScheduleSchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { configureJourneySchedule } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, journeyScheduleSchema)
    return NextResponse.json({
      ok: true,
      data: await configureJourneySchedule({
        agencyId: auth.workspace.id,
        journeyId: assertUuid(id, "journey ID"),
        ...input,
      }),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
