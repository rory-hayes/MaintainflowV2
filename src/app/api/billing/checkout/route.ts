import { NextResponse, type NextRequest } from "next/server"

import { getBillingInterval, isBillingInterval, isBillingPlanId } from "@/lib/billing/plans"
import { checkoutConfigReason, createStripeCheckoutSession, getTrustedBillingOrigin } from "@/lib/billing/stripe"
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
    return NextResponse.json({ error: "Sign in before opening Stripe checkout." }, { status: 401 })
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? ""
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return NextResponse.json({ error: "A valid Idempotency-Key header is required." }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as { plan?: string; interval?: string }
  const plan = body.plan ?? "growth"
  const interval = getBillingInterval(body.interval)

  if (!isBillingPlanId(plan) || plan === "free" || plan === "agency_plus") {
    return NextResponse.json({ error: "Select Solo, Team, or Agency before opening Stripe checkout." }, { status: 400 })
  }

  if (body.interval && !isBillingInterval(body.interval)) {
    return NextResponse.json({ error: "Select monthly or annual billing before opening Stripe checkout." }, { status: 400 })
  }

  try {
    const workspace = await loadBillingWorkspaceForToken(token, request.headers.get("x-maintainflow-workspace-id"))
    assertBillingAdmin(workspace)
    const existingStatus = workspace.agency.stripeSubscriptionStatus
    if (
      workspace.agency.stripeSubscriptionId
      && existingStatus !== "canceled"
      && existingStatus !== "incomplete_expired"
    ) {
      return NextResponse.json(
        { error: "Manage the existing subscription in Stripe Customer Portal before starting another checkout." },
        { status: 409 }
      )
    }
    const configReason = checkoutConfigReason(plan, interval)
    if (configReason) {
      return NextResponse.json({ error: configReason }, { status: 503 })
    }
    const url = await createStripeCheckoutSession({
      planId: plan,
      interval,
      origin: getTrustedBillingOrigin(request.nextUrl.origin),
      agencyId: workspace.agency.id,
      userId: workspace.user.id,
      customerId: workspace.agency.stripeCustomerId,
      customerEmail: workspace.user.email,
      idempotencyKey,
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
      { error: error instanceof Error ? error.message : "Stripe checkout could not be opened." },
      { status }
    )
  }
}
