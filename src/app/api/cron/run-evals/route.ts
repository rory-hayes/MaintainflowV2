import { handleRunChecksCronRequest } from "@/lib/core/cron-route-handler"
import { runScheduledBusinessEvals } from "@/lib/workflows/scheduled-evals.server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
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
