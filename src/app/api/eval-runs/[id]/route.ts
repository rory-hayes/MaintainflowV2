import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { requireIdempotencyKey } from "@/lib/api/business-evals-contracts"
import { getEvalRun, requestEvalRunCancellation } from "@/lib/api/eval-runs.server"
import { deriveEvalEmailHookToken } from "@/lib/email/eval-inbound"
import { evalEmailHook } from "@/workflows/eval-run"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    return NextResponse.json({ ok: true, data: await getEvalRun(auth.workspace.id, assertUuid(id, "eval-run ID")) })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id } = await params
    const evalRunId = assertUuid(id, "eval-run ID")
    const cancellation = await requestEvalRunCancellation(
      auth.workspace.id,
      evalRunId,
      auth.user.id,
      requireIdempotencyKey(request)
    )
    const secret = process.env.EVAL_EMAIL_ROUTING_SECRET?.trim() ?? ""
    if (secret.length >= 32) {
      await evalEmailHook.resume(deriveEvalEmailHookToken(evalRunId, secret), {
        kind: "cancelled",
        requestedAt: cancellation.cancelRequestedAt,
      }).catch(() => undefined)
    }
    return NextResponse.json({ ok: true, data: cancellation }, { status: 202 })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
