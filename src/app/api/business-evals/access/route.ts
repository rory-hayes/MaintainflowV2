import { NextRequest, NextResponse } from "next/server"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { isBusinessEvalsWorkspaceEnabled } from "@/lib/features/business-evals"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { featureGate: false, allowImplicitWorkspace: true })
    return NextResponse.json({
      ok: true,
      data: {
        enabled: isBusinessEvalsWorkspaceEnabled(auth.workspace.id),
        workspaceId: auth.workspace.id,
      },
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
