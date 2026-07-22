import "server-only"

import { businessEvalsBillingContractVersion } from "@/lib/billing/plans"
import {
  assertStripeCheckoutSessionMatchesReservation,
  retrieveStripeCheckoutSession,
  retrieveStripeSubscription,
} from "@/lib/billing/stripe"
import {
  finishStripeCheckoutSession,
  loadStripeCheckoutSessionForReturn,
} from "@/lib/billing/stripe-checkout-sessions.server"
import { reconcileStripeSubscriptionSnapshot } from "@/lib/billing/stripe-subscription-reconciliation.server"

export type StripeCheckoutReturnResult = {
  status: "active" | "pending" | "expired"
  planId: string
  interval: string
  subscriptionStatus: string
  message: string
}

export async function reconcileStripeCheckoutReturn(input: {
  agencyId: string
  userId: string
  stripeSessionId: string
}): Promise<StripeCheckoutReturnResult> {
  const reservation = await loadStripeCheckoutSessionForReturn(input)
  if (!reservation) {
    throw new Error("This Stripe Checkout Session does not belong to the selected workspace.")
  }
  const session = await retrieveStripeCheckoutSession(input.stripeSessionId)
  assertStripeCheckoutSessionMatchesReservation(session, reservation)

  if (session.status === "open") {
    return {
      status: "pending",
      planId: reservation.planId,
      interval: reservation.interval,
      subscriptionStatus: "",
      message: "Stripe Checkout is still open. Complete it before Maintain Flow enables the plan.",
    }
  }
  if (session.status === "expired") {
    await finishStripeCheckoutSession({
      agencyId: reservation.agencyId,
      stripeSessionId: session.id,
      status: "expired",
    })
    return {
      status: "expired",
      planId: reservation.planId,
      interval: reservation.interval,
      subscriptionStatus: "",
      message: "This Stripe Checkout Session expired without changing the workspace plan.",
    }
  }
  if (!session.customerId || !session.subscriptionId) {
    throw new Error("Completed Stripe Checkout is missing its customer or subscription identity.")
  }

  const subscription = await retrieveStripeSubscription(session.subscriptionId)
  if (subscription.metadata?.maintainflow_billing_interval !== reservation.interval) {
    throw new Error("Stripe subscription billing interval does not match the checkout reservation.")
  }
  if (subscription.metadata?.maintainflow_billing_contract !== businessEvalsBillingContractVersion) {
    throw new Error("Stripe subscription billing contract does not match the current Maintain Flow contract.")
  }
  const reconciled = await reconcileStripeSubscriptionSnapshot(subscription, {
    agencyId: reservation.agencyId,
    customerId: session.customerId,
    planId: reservation.planId,
  })
  await finishStripeCheckoutSession({
    agencyId: reservation.agencyId,
    stripeSessionId: session.id,
    status: "complete",
  })

  return {
    status: reconciled.grantsPaidAccess ? "active" : "pending",
    planId: reservation.planId,
    interval: reservation.interval,
    subscriptionStatus: reconciled.subscriptionStatus,
    message: reconciled.grantsPaidAccess
      ? "Stripe confirmed the subscription and Maintain Flow enabled the workspace plan."
      : "Stripe completed checkout, but the subscription is not active yet. Maintain Flow has not enabled paid access.",
  }
}
