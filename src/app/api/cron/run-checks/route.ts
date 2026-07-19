import { handleRunChecksCronRequest } from "@/lib/core/cron-route-handler"
import { runScheduledChecks } from "@/lib/core/scheduled-runner"
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
    defaultBatchSize: process.env.CHECK_RUNNER_BATCH_SIZE,
    defaultLeaseSeconds: process.env.CHECK_RUNNER_LEASE_SECONDS,
    runner: runScheduledChecks,
  })

  return NextResponse.json(response.body, { status: response.status })
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST." }, { status: 405 })
}
