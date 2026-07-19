import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { includeArchivedQuerySchema, journeyDraftSchema, pageQuerySchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { createJourneyDraft, listJourneys } from "@/lib/api/journeys.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const query = pageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams))
    const includeArchived = includeArchivedQuerySchema.parse(request.nextUrl.searchParams.get("includeArchived") ?? undefined)
    const projectId = request.nextUrl.searchParams.get("projectId")?.trim()
    const result = await listJourneys({
      agencyId: auth.workspace.id,
      ...query,
      ...(projectId ? { projectId: assertUuid(projectId, "project ID") } : {}),
      includeArchived,
    })
    return NextResponse.json({ ok: true, data: result.journeys, meta: { nextCursor: result.nextCursor } })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const input = await parseRequestJson(request, journeyDraftSchema)
    return NextResponse.json({ ok: true, data: await createJourneyDraft(auth.workspace.id, input) }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
