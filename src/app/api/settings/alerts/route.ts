import { NextRequest, NextResponse } from "next/server"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { alertEndpointSchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { createAlertEndpoint, listAlertSettings } from "@/lib/api/alerts.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    return NextResponse.json(
      { ok: true, data: await listAlertSettings(auth.workspace.id) },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const input = await parseRequestJson(request, alertEndpointSchema)
    const result = await createAlertEndpoint({
      agencyId: auth.workspace.id,
      userId: auth.user.id,
      ...input,
    })
    return NextResponse.json({ ok: true, data: result }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
