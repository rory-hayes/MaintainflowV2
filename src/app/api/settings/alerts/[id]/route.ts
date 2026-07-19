import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { parseRequestJson } from "@/lib/api/business-evals-contracts"
import { deleteAlertEndpoint, updateAlertEndpoint } from "@/lib/api/alerts.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

const updateAlertEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  destination: z.string().trim().min(1).max(2_048).optional(),
  enabled: z.boolean().optional(),
  rotateSigningSecret: z.boolean().optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "Provide at least one alert destination change.",
})

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const input = await parseRequestJson(request, updateAlertEndpointSchema)
    const result = await updateAlertEndpoint({
      agencyId: auth.workspace.id,
      endpointId: assertUuid(id, "alert endpoint ID"),
      ...input,
    })
    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const { id } = await params
    const result = await deleteAlertEndpoint(auth.workspace.id, assertUuid(id, "alert endpoint ID"))
    return NextResponse.json({ ok: true, data: result })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
