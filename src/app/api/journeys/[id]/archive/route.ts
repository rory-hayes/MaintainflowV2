import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { archiveJourney, restoreJourney } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    return NextResponse.json({
      ok: true,
      data: await archiveJourney({
        agencyId: auth.workspace.id,
        journeyId: assertUuid(id, "journey ID"),
        actorUserId: auth.user.id,
      }),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    return NextResponse.json({
      ok: true,
      data: await restoreJourney({
        agencyId: auth.workspace.id,
        journeyId: assertUuid(id, "journey ID"),
        actorUserId: auth.user.id,
      }),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
