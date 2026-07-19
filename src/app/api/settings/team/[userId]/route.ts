import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { removeWorkspaceTeamMember, updateWorkspaceTeamMember } from "@/lib/api/workspace-settings.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ userId: string }> }

const roleSchema = z.object({ role: z.enum(["admin", "member"]) })

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner"] })
    const { userId } = await params
    const input = roleSchema.parse(await request.json().catch(() => null))
    return NextResponse.json({
      ok: true,
      data: await updateWorkspaceTeamMember({
        agencyId: auth.workspace.id,
        actorUserId: auth.user.id,
        memberUserId: assertUuid(userId, "member user ID"),
        role: input.role,
      }),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner"] })
    const { userId } = await params
    return NextResponse.json({
      ok: true,
      data: await removeWorkspaceTeamMember({
        agencyId: auth.workspace.id,
        actorUserId: auth.user.id,
        memberUserId: assertUuid(userId, "member user ID"),
      }),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
