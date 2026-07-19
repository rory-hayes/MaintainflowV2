import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { parseRequestJson } from "@/lib/api/business-evals-contracts"
import { pauseJourney } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, z.object({ reason: z.string().trim().min(1).max(500) }))
    return NextResponse.json({ ok: true, data: await pauseJourney(auth.workspace.id, assertUuid(id, "journey ID"), input.reason) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
