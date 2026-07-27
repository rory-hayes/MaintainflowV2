import { NextResponse, type NextRequest } from "next/server"

import { getBillingInterval, isBillingInterval, isBillingPlanId } from "@/lib/billing/plans"
import {
  assertStripeCheckoutSessionMatchesReservation,
  checkoutConfigReason,
  createStripeCheckoutSession,
  expireStripeCheckoutSession,
  getTrustedBillingOrigin,
  retrieveStripeCheckoutSession,
} from "@/lib/billing/stripe"
import { reconcileStripeCheckoutReturn } from "@/lib/billing/stripe-checkout-return.server"
import {
  finishStripeCheckoutSession,
  recordStripeCheckoutSession,
  reserveStripeCheckoutSession,
  type StripeCheckoutReservation,
} from "@/lib/billing/stripe-checkout-sessions.server"
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
    return NextResponse.json({ error: "Sign in before opening Stripe checkout." }, { status: 401 })
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? ""
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return NextResponse.json({ error: "A valid Idempotency-Key header is required." }, { status: 400 })
  }

  try {
    const workspace = await loadBillingWorkspaceForToken(token, request.headers.get("x-maintainflow-workspace-id"))
    assertBillingAdmin(workspace)
    const payload = await readBoundedJson(request, 2_048)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return NextResponse.json({ error: "Select a supported billing plan." }, { status: 400 })
    }
    const body = payload as { plan?: string; interval?: string }
    const plan = body.plan ?? "growth"
    const interval = getBillingInterval(body.interval)
    if (!isBillingPlanId(plan) || plan === "free" || plan === "agency_plus") {
      return NextResponse.json({ error: "Select Solo, Team, or Agency before opening Stripe checkout." }, { status: 400 })
    }
    if (body.interval && !isBillingInterval(body.interval)) {
      return NextResponse.json({ error: "Select monthly or annual billing before opening Stripe checkout." }, { status: 400 })
    }
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
    const reservationInput = {
      agencyId: workspace.agency.id,
      userId: workspace.user.id,
      planId: plan,
      interval,
      origin: getTrustedBillingOrigin(request.nextUrl.origin),
      customerId: workspace.agency.stripeCustomerId,
      customerEmail: workspace.user.email,
      idempotencyKey,
    } as const
    let reservation = await reserveStripeCheckoutSession(reservationInput)

    if (reservation.planId !== plan || reservation.interval !== interval) {
      reservation = await replaceIncompleteCheckout(reservation, reservationInput)
    }
    if (reservation.planId !== plan || reservation.interval !== interval) {
      return NextResponse.json(
        {
          error: `Another administrator opened ${reservation.planId} ${reservation.interval} checkout first. No checkout was opened for your selection.`,
          activeCheckout: {
            plan: reservation.planId,
            interval: reservation.interval,
            expiresAt: reservation.expiresAt,
          },
        },
        { status: 409 }
      )
    }
    if (reservation.status === "complete") {
      return NextResponse.json(
        { error: "Stripe already completed this checkout. Refresh billing before starting another." },
        { status: 409 }
      )
    }
    if (reservation.status === "expired" || reservation.status === "failed") {
      return NextResponse.json(
        { error: "That checkout request is no longer active. Choose the plan again to create a new checkout." },
        { status: 409 }
      )
    }

    const session = await createStripeCheckoutSession({
      planId: reservation.planId,
      interval: reservation.interval,
      origin: reservation.origin,
      agencyId: reservation.agencyId,
      userId: reservation.requestedByUserId,
      reservationId: reservation.id,
      customerId: reservation.customerId,
      customerEmail: reservation.customerEmail,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      providerExpiresAt: reservation.providerExpiresAt,
    })
    if (session.status !== "open" || !session.url) {
      throw new Error("Stripe Checkout is no longer open. Choose the plan again after billing refreshes.")
    }
    const recorded = await recordStripeCheckoutSession({
      reservation,
      stripeSessionId: session.id,
      checkoutUrl: session.url,
      providerExpiresAt: new Date(session.expiresAt * 1000).toISOString(),
    })
    assertStripeCheckoutSessionMatchesReservation(session, recorded)

    return NextResponse.json({
      url: session.url,
      reused: reservation.stripeSessionId === session.id,
      plan: reservation.planId,
      interval: reservation.interval,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe checkout could not be opened."
    const status = error instanceof BoundedJsonRequestError
      ? error.status
      : error instanceof BillingAuthenticationError
      ? 401
      : error instanceof BillingAuthorizationError
        ? 403
        : error instanceof BillingWorkspaceRequiredError
          ? 409
          : /STRIPE_SUBSCRIPTION_ALREADY_LINKED|STRIPE_CHECKOUT_IDEMPOTENCY_REUSED/.test(message)
            ? 409
          : 500
    return NextResponse.json(
      { error: safeCheckoutError(message) },
      { status }
    )
  }
}

async function replaceIncompleteCheckout(
  existing: StripeCheckoutReservation,
  requested: Parameters<typeof reserveStripeCheckoutSession>[0]
) {
  if (!existing.stripeSessionId) {
    throw new Error("Another plan checkout is being prepared for this workspace. Wait a moment and try again.")
  }
  let providerSession = await retrieveStripeCheckoutSession(existing.stripeSessionId)
  assertStripeCheckoutSessionMatchesReservation(providerSession, existing)
  if (providerSession.status === "complete") {
    await reconcileStripeCheckoutReturn({
      agencyId: existing.agencyId,
      userId: requested.userId,
      stripeSessionId: providerSession.id,
    })
    throw new Error("Stripe already completed the existing checkout. Manage the linked subscription instead.")
  }
  if (providerSession.status === "open") {
    try {
      providerSession = await expireStripeCheckoutSession(providerSession.id)
    } catch {
      // Another administrator may have expired this exact Session between the
      // read and mutation. Re-read Stripe truth before deciding whether it is
      // safe to reserve the competing selection.
      providerSession = await retrieveStripeCheckoutSession(existing.stripeSessionId)
    }
    assertStripeCheckoutSessionMatchesReservation(providerSession, existing)
  }
  if (providerSession.status === "complete") {
    await reconcileStripeCheckoutReturn({
      agencyId: existing.agencyId,
      userId: requested.userId,
      stripeSessionId: providerSession.id,
    })
    throw new Error("Stripe already completed the existing checkout. Manage the linked subscription instead.")
  }
  if (providerSession.status !== "expired") {
    throw new Error("Stripe could not safely close the previous checkout.")
  }
  await finishStripeCheckoutSession({
    agencyId: existing.agencyId,
    stripeSessionId: providerSession.id,
    status: "expired",
  })
  return reserveStripeCheckoutSession(requested)
}

function safeCheckoutError(message: string) {
  if (message.includes("STRIPE_SUBSCRIPTION_ALREADY_LINKED")) {
    return "Manage the existing subscription in Stripe Customer Portal before starting another checkout."
  }
  if (message.includes("STRIPE_CHECKOUT_IDEMPOTENCY_REUSED")) {
    return "This checkout request was already used for another selection. Choose the plan again."
  }
  return message
}
