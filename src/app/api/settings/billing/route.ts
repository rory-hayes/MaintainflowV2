import { NextRequest, NextResponse } from "next/server"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { getWorkspaceBillingSettings } from "@/lib/api/workspace-settings.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    return NextResponse.json({ ok: true, data: await getWorkspaceBillingSettings(auth.workspace.id) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
