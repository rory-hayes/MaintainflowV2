import { NextRequest, NextResponse } from "next/server"

import { createAiJourneyDraft } from "@/lib/api/business-evals-ai.server"
import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import {
  aiJourneyDraftRequestSchema,
  parseRequestJson,
  requireIdempotencyKey,
} from "@/lib/api/business-evals-contracts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const body = await parseRequestJson(request, aiJourneyDraftRequestSchema)
    const data = await createAiJourneyDraft({
      agencyId: auth.workspace.id,
      userId: auth.user.id,
      idempotencyKey: requireIdempotencyKey(request),
      request: body,
    })
    return NextResponse.json({ ok: true, data }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
