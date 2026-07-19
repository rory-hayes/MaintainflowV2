import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { enqueueEvalRunSchema, pageQuerySchema, parseRequestJson, requireIdempotencyKey } from "@/lib/api/business-evals-contracts"
import { enqueueEvalRunRecord, getEvalRunDispatchState, listEvalRuns } from "@/lib/api/eval-runs.server"
import { dispatchEvalRun } from "@/lib/workflows/dispatch-eval-run.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const page = pageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams))
    const journeyId = request.nextUrl.searchParams.get("journeyId")?.trim()
    const result = await listEvalRuns({
      agencyId: auth.workspace.id,
      ...page,
      ...(journeyId ? { journeyId: assertUuid(journeyId, "journey ID") } : {}),
    })
    return NextResponse.json({ ok: true, data: result.runs, meta: { nextCursor: result.nextCursor } })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const idempotencyKey = requireIdempotencyKey(request)
    const run = await parseRequestJson(request, enqueueEvalRunSchema)
    const enqueued = await enqueueEvalRunRecord({
      agencyId: auth.workspace.id,
      userId: auth.user.id,
      idempotencyKey,
      run,
    })
    const dispatchState = enqueued.enqueued
      ? null
      : await getEvalRunDispatchState(auth.workspace.id, enqueued.id)
    // Dispatch owns the final kill-switch recheck. Calling it after enqueue
    // closes the race where the switch flips between persistence and start.
    const shouldDispatch = (
      enqueued.enqueued || Boolean(
        dispatchState
        && ["queued", "claimed", "running"].includes(dispatchState.status)
        && !dispatchState.orchestrationRunId
        && dispatchState.dispatchState !== "dispatching"
      )
    )
    const orchestration = shouldDispatch
      ? await dispatchEvalRun({ agencyId: auth.workspace.id, evalRunId: enqueued.id })
      : null
    return NextResponse.json({
      ok: true,
      data: { ...enqueued, orchestrationRunId: orchestration?.orchestrationRunId ?? null },
    }, { status: enqueued.enqueued ? 202 : 200 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
