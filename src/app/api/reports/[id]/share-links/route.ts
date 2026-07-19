import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { parseRequestJson, reportShareLinkSchema, requireIdempotencyKey } from "@/lib/api/business-evals-contracts"
import { createReportShareLink, revokeReportShareLink } from "@/lib/api/report-sharing.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, reportShareLinkSchema)
    const data = await createReportShareLink({
      agencyId: auth.workspace.id,
      reportId: assertUuid(id, "report ID"),
      userId: auth.user.id,
      expiresInHours: input.expiresInHours,
      idempotencyKey: requireIdempotencyKey(request),
      origin: request.nextUrl.origin,
    })
    return NextResponse.json({ ok: true, data }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, z.object({ linkId: z.string().uuid() }).strict())
    const data = await revokeReportShareLink({
      agencyId: auth.workspace.id,
      reportId: assertUuid(id, "report ID"),
      linkId: input.linkId,
      userId: auth.user.id,
      idempotencyKey: requireIdempotencyKey(request),
    })
    return NextResponse.json({ ok: true, data })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
