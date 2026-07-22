import { handleRunChecksCronRequest } from "@/lib/core/cron-route-handler"
import { isAuthorizedCronRequest } from "@/lib/core/cron-auth"
import { runScheduledBusinessEvals } from "@/lib/workflows/scheduled-evals.server"
import { BoundedJsonRequestError, readOptionalBoundedJson } from "@/lib/http/bounded-json.server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }
  let body: unknown
  try {
    body = await readOptionalBoundedJson(request, 2_048)
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid request body." },
      { status: error instanceof BoundedJsonRequestError ? error.status : 400 },
    )
  }
  const response = await handleRunChecksCronRequest({
    authorizationHeader: request.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    body,
    defaultBatchSize: process.env.BUSINESS_EVALS_SCHEDULER_BATCH_SIZE,
    defaultLeaseSeconds: process.env.BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS,
    runner: runScheduledBusinessEvals,
  })

  return NextResponse.json(response.body, { status: response.status })
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST." }, { status: 405 })
}
