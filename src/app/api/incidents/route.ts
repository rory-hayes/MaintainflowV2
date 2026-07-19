import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { pageQuerySchema } from "@/lib/api/business-evals-contracts"
import { listIncidents } from "@/lib/api/incidents.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const page = pageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams))
    const journeyId = request.nextUrl.searchParams.get("journeyId")?.trim()
    const projectId = request.nextUrl.searchParams.get("projectId")?.trim()
    const result = await listIncidents({
      agencyId: auth.workspace.id,
      ...page,
      ...(journeyId ? { journeyId: assertUuid(journeyId, "journey ID") } : {}),
      ...(projectId ? { projectId: assertUuid(projectId, "project ID") } : {}),
    })
    return NextResponse.json({ ok: true, data: result.incidents, meta: { nextCursor: result.nextCursor } })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
