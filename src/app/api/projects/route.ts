import { NextRequest, NextResponse } from "next/server"

import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { createProjectSchema, pageQuerySchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { createProject, listProjects } from "@/lib/api/projects.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const query = pageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams))
    const result = await listProjects({ agencyId: auth.workspace.id, ...query })
    return NextResponse.json({ ok: true, data: result.projects, meta: { nextCursor: result.nextCursor } })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const input = await parseRequestJson(request, createProjectSchema)
    const project = await createProject(auth.workspace.id, auth.user.id, input)
    return NextResponse.json({ ok: true, data: project }, { status: 201 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
