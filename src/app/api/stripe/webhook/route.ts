import type { NextRequest } from "next/server"

import { POST as handleBillingWebhook } from "../../billing/webhook/route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function POST(request: NextRequest) {
  return handleBillingWebhook(request)
}
