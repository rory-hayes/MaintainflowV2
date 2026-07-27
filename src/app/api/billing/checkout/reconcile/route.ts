import { NextResponse, type NextRequest } from "next/server"

import { reconcileStripeCheckoutReturn } from "@/lib/billing/stripe-checkout-return.server"
import {
  assertBillingAdmin,
  BillingAuthenticationError,
  BillingAuthorizationError,
  BillingWorkspaceRequiredError,
  loadBillingWorkspaceForToken,
} from "@/lib/billing/workspace.server"
import { BoundedJsonRequestError, readBoundedJson } from "@/lib/http/bounded-json.server"
import { bearerToken } from "@/lib/supabase/report-download.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return NextResponse.json({ error: "Sign in before reconciling Stripe checkout." }, { status: 401 })
  }
  try {
    const workspace = await loadBillingWorkspaceForToken(token, request.headers.get("x-maintainflow-workspace-id"))
    assertBillingAdmin(workspace)
    const payload = await readBoundedJson(request, 2_048)
    const sessionId = payload && typeof payload === "object" && !Array.isArray(payload)
      ? String((payload as { sessionId?: unknown }).sessionId ?? "").trim()
      : ""
    if (sessionId.length < 8 || sessionId.length > 255 || /\s/.test(sessionId)) {
      return NextResponse.json({ error: "Stripe checkout return is missing a valid Session ID." }, { status: 400 })
    }
    const result = await reconcileStripeCheckoutReturn({
      agencyId: workspace.agency.id,
      userId: workspace.user.id,
      stripeSessionId: sessionId,
    })
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    const status = error instanceof BoundedJsonRequestError
      ? error.status
      : error instanceof BillingAuthenticationError
      ? 401
      : error instanceof BillingAuthorizationError
        ? 403
        : error instanceof BillingWorkspaceRequiredError
          ? 409
          : error instanceof Error && error.message.includes("does not belong to the selected workspace")
            ? 404
            : 500
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stripe checkout could not be reconciled." },
      { status, headers: { "Cache-Control": "private, no-store" } }
    )
  }
}
