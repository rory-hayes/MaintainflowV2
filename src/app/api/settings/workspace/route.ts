import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { getWorkspaceSettings, updateWorkspaceSettings } from "@/lib/api/workspace-settings.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const workspaceSettingsSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  name: z.string().trim().min(1).max(120),
  reportSenderName: z.string().trim().max(120),
  reportSenderEmail: z.union([z.literal(""), z.string().trim().email().max(320)]),
  primaryColor: z.union([z.null(), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    return NextResponse.json({ ok: true, data: await getWorkspaceSettings(auth.workspace.id) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const input = workspaceSettingsSchema.parse(await request.json().catch(() => null))
    return NextResponse.json({
      ok: true,
      data: await updateWorkspaceSettings({ agencyId: auth.workspace.id, ...input }),
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
