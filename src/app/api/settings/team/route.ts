import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { inviteWorkspaceTeamMember, listWorkspaceTeam } from "@/lib/api/workspace-settings.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const inviteSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(["admin", "member"]).default("member"),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    return NextResponse.json({ ok: true, data: await listWorkspaceTeam(auth.workspace.id) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const input = inviteSchema.parse(await request.json().catch(() => null))
    return NextResponse.json({
      ok: true,
      data: await inviteWorkspaceTeamMember({
        agencyId: auth.workspace.id,
        actorUserId: auth.user.id,
        actorRole: auth.workspace.role,
        email: input.email,
        role: input.role,
        origin: request.nextUrl.origin,
      }),
    }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
