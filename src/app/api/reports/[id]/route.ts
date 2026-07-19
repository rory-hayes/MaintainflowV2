import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { getReport } from "@/lib/api/reports.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    return NextResponse.json({ ok: true, data: await getReport(auth.workspace.id, assertUuid(id, "report ID")) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
