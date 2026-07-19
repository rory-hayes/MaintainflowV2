import { NextRequest, NextResponse } from "next/server"

import { deliverPendingEvalAlerts } from "@/lib/api/alerts-delivery.server"
import { isAuthorizedCronRequest } from "@/lib/core/cron-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const requested = Number(body.batchSize ?? process.env.ALERT_DELIVERY_BATCH_SIZE ?? 10)
  const batchSize = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 25)) : 10
  try {
    const result = await deliverPendingEvalAlerts({ batchSize })
    return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), ...result })
  } catch {
    return NextResponse.json(
      { ok: false, error: "Alert deliveries could not be processed." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Use POST." }, { status: 405 })
}
