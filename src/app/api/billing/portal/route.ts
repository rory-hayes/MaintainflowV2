import { NextResponse, type NextRequest } from "next/server"

import {
  createStripeCustomerPortalSession,
  getTrustedBillingOrigin,
  isBillingPortalFlow,
  portalConfigReason,
} from "@/lib/billing/stripe"
import {
  assertBillingAdmin,
  BillingAuthenticationError,
  BillingAuthorizationError,
  BillingWorkspaceRequiredError,
  loadBillingWorkspaceForToken,
} from "@/lib/billing/workspace.server"
import { bearerToken } from "@/lib/supabase/report-download.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return NextResponse.json({ error: "Sign in before opening the Stripe customer portal." }, { status: 401 })
  }

  try {
    const workspace = await loadBillingWorkspaceForToken(token, request.headers.get("x-maintainflow-workspace-id"))
    assertBillingAdmin(workspace)
    const body = (await request.json().catch(() => ({}))) as { flow?: string }
    const flow = body.flow ?? "manage"
    if (!isBillingPortalFlow(flow)) {
      return NextResponse.json({ error: "Select a supported Stripe customer portal action." }, { status: 400 })
    }

    const configReason = portalConfigReason(
      workspace.agency.stripeCustomerId,
      flow,
      workspace.agency.stripeSubscriptionId
    )
    if (configReason) {
      return NextResponse.json({ error: configReason }, { status: 503 })
    }

    const url = await createStripeCustomerPortalSession({
      customerId: workspace.agency.stripeCustomerId,
      subscriptionId: workspace.agency.stripeSubscriptionId,
      origin: getTrustedBillingOrigin(request.nextUrl.origin),
      flow,
    })

    return NextResponse.json({ url })
  } catch (error) {
    const status = error instanceof BillingAuthenticationError
      ? 401
      : error instanceof BillingAuthorizationError
        ? 403
        : error instanceof BillingWorkspaceRequiredError
          ? 409
          : 500
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stripe customer portal could not be opened." },
      { status }
    )
  }
}
