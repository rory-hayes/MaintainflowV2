import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { createReportSchema, pageQuerySchema, parseRequestJson, requireIdempotencyKey } from "@/lib/api/business-evals-contracts"
import { createReportSnapshot, listReports } from "@/lib/api/reports.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const page = pageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams))
    const projectId = request.nextUrl.searchParams.get("projectId")?.trim()
    const result = await listReports({
      agencyId: auth.workspace.id,
      limit: page.limit,
      cursor: page.cursor,
      ...(projectId ? { projectId: assertUuid(projectId, "project ID") } : {}),
    })
    return NextResponse.json({ ok: true, data: result.reports, meta: { nextCursor: result.nextCursor } })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const input = await parseRequestJson(request, createReportSchema)
    const data = await createReportSnapshot({
      agencyId: auth.workspace.id,
      projectId: input.projectId,
      userId: auth.user.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      idempotencyKey: requireIdempotencyKey(request),
    })
    return NextResponse.json({ ok: true, data }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
