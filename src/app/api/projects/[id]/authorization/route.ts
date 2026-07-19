import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { parseRequestJson, projectAuthorizationSchema } from "@/lib/api/business-evals-contracts"
import { getLatestProjectAuthorization, recordProjectAuthorization } from "@/lib/api/projects.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    const projectId = assertUuid(id, "project ID")
    return NextResponse.json({
      ok: true,
      data: await getLatestProjectAuthorization(auth.workspace.id, projectId),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner"] })
    const { id } = await params
    const projectId = assertUuid(id, "project ID")
    const input = await parseRequestJson(request, projectAuthorizationSchema)
    if (input.projectId !== projectId) {
      return NextResponse.json(
        { ok: false, error: { code: "PROJECT_MISMATCH", message: "The authorization must match the route project." } },
        { status: 400 }
      )
    }
    const authorization = await recordProjectAuthorization({
      agencyId: auth.workspace.id,
      projectId,
      userId: auth.user.id,
      domain: input.domain,
      attestationVersion: input.attestationVersion,
      approvedActionDomains: input.approvedActionDomains,
    })
    return NextResponse.json({ ok: true, data: authorization }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
