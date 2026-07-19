import { NextRequest, NextResponse } from "next/server"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { parseRequestJson } from "@/lib/api/business-evals-contracts"
import { legacyCoreSyncRequestSchema } from "@/lib/legacy/core-sync-contract"
import { applyLegacyCoreSync } from "@/lib/legacy/core-sync.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, {
      featureGate: false,
      roles: ["owner", "admin", "member"],
    })
    const input = await parseRequestJson(request, legacyCoreSyncRequestSchema)
    const result = await applyLegacyCoreSync({
      agencyId: auth.workspace.id,
      userId: auth.user.id,
      request: input,
    })
    return NextResponse.json(
      { ok: true, data: result },
      { headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
