import { NextRequest, NextResponse } from "next/server"

import {
  assertBillingAdmin,
  BillingAuthenticationError,
  BillingAuthorizationError,
  BillingWorkspaceRequiredError,
  loadBillingWorkspaceForToken,
  startCardFreeTeamTrial,
} from "@/lib/billing/workspace.server"
import { bearerToken } from "@/lib/supabase/report-download.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) return NextResponse.json({ error: "Sign in before starting the Team trial." }, { status: 401 })
  try {
    const workspace = await loadBillingWorkspaceForToken(token, request.headers.get("x-maintainflow-workspace-id"))
    assertBillingAdmin(workspace)
    if (workspace.agency.stripeSubscriptionId) {
      return NextResponse.json({ error: "This workspace already has a Stripe subscription." }, { status: 409 })
    }
    const trial = await startCardFreeTeamTrial(workspace.agency.id)
    return NextResponse.json({ ok: true, data: { plan: "growth", name: "Team", ...trial } }, { status: 201 })
  } catch (error) {
    const status = error instanceof BillingAuthenticationError
      ? 401
      : error instanceof BillingAuthorizationError
        ? 403
        : error instanceof BillingWorkspaceRequiredError
          ? 409
          : 500
    return NextResponse.json({ error: error instanceof Error ? error.message : "The Team trial could not be started." }, { status })
  }
}
