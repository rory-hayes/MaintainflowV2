import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { incidentMutationSchema, parseRequestJson, requireIdempotencyKey } from "@/lib/api/business-evals-contracts"
import { enqueueEvalRunRecord } from "@/lib/api/eval-runs.server"
import { getIncident, mutateIncident } from "@/lib/api/incidents.server"
import { dispatchEvalRun } from "@/lib/workflows/dispatch-eval-run.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    return NextResponse.json({ ok: true, data: await getIncident(auth.workspace.id, assertUuid(id, "incident ID")) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    const incidentId = assertUuid(id, "incident ID")
    const mutation = await parseRequestJson(request, incidentMutationSchema)
    if (mutation.action !== "verify") {
      const data = await mutateIncident({
        agencyId: auth.workspace.id,
        incidentId,
        userId: auth.user.id,
        mutation,
      })
      return NextResponse.json({ ok: true, data })
    }

    const incident = await getIncident(auth.workspace.id, incidentId)
    const enqueued = await enqueueEvalRunRecord({
      agencyId: auth.workspace.id,
      userId: auth.user.id,
      idempotencyKey: requireIdempotencyKey(request),
      run: { journeyId: incident.journeyId, mode: "verification", incidentId },
    })
    const orchestration = enqueued.enqueued
      ? await dispatchEvalRun({ agencyId: auth.workspace.id, evalRunId: enqueued.id })
      : null
    return NextResponse.json({
      ok: true,
      data: {
        ...enqueued,
        journeyId: incident.journeyId,
        orchestrationRunId: orchestration?.orchestrationRunId ?? null,
      },
    }, { status: enqueued.enqueued ? 202 : 200 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
