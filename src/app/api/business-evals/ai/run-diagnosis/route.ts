import { NextRequest, NextResponse } from "next/server"

import { createAiRunDiagnosis } from "@/lib/api/business-evals-ai.server"
import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import {
  aiRunDiagnosisRequestSchema,
  parseRequestJson,
  requireIdempotencyKey,
} from "@/lib/api/business-evals-contracts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const body = await parseRequestJson(request, aiRunDiagnosisRequestSchema)
    const data = await createAiRunDiagnosis({
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
