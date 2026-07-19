import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { parseRequestJson, updateProjectSchema } from "@/lib/api/business-evals-contracts"
import { getProject, updateProject } from "@/lib/api/projects.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    return NextResponse.json({ ok: true, data: await getProject(auth.workspace.id, assertUuid(id, "project ID")) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, updateProjectSchema)
    return NextResponse.json({ ok: true, data: await updateProject(auth.workspace.id, assertUuid(id, "project ID"), input) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  const cloned = new Request(request, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
    headers: { ...Object.fromEntries(request.headers), "Content-Type": "application/json" },
  })
  return PATCH(cloned as NextRequest, context)
}
