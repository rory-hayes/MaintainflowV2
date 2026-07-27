import "server-only"

import {
  entitledPlanForStripeStatus,
  normalizeStripeSubscriptionStatus,
} from "@/lib/billing/entitlements"
import {
  businessEvalsBillingContractVersion,
  type BillingPlanId,
} from "@/lib/billing/plans"
import {
  resolveStripeSubscriptionPlanId,
  type StripeSubscriptionSnapshot,
} from "@/lib/billing/stripe"
import {
  loadAgencyBillingContractVersionByStripeReference,
  updateAgencyBilling,
  updateAgencyBillingByStripeReference,
} from "@/lib/billing/workspace.server"

export async function reconcileStripeSubscriptionSnapshot(
  subscription: StripeSubscriptionSnapshot,
  expected: {
    agencyId?: string
    customerId?: string
    planId?: BillingPlanId
  } = {}
) {
  const subscriptionId = valueOrEmpty(subscription.id)
  const customerId = valueOrEmpty(subscription.customer)
  const metadataAgencyId = valueOrEmpty(subscription.metadata?.maintainflow_agency_id)
  const agencyId = expected.agencyId || metadataAgencyId
  const metadataPlan = subscription.metadata?.maintainflow_plan
  const subscriptionBillingContract = subscription.metadata?.maintainflow_billing_contract

  if (!subscriptionId || !customerId) {
    throw new Error("Stripe subscription reconciliation is missing its subscription or customer identity.")
  }
  if (expected.agencyId && metadataAgencyId !== expected.agencyId) {
    throw new Error("Stripe subscription metadata does not match this workspace.")
  }
  if (expected.customerId && customerId !== expected.customerId) {
    throw new Error("Stripe subscription customer does not match the completed Checkout Session.")
  }

  const storedBillingContract = await loadAgencyBillingContractVersionByStripeReference({
    agencyId,
    customerId,
    subscriptionId,
  })
  const effectiveBillingContract = storedBillingContract === businessEvalsBillingContractVersion
    || subscriptionBillingContract === businessEvalsBillingContractVersion
    ? businessEvalsBillingContractVersion
    : storedBillingContract ?? subscriptionBillingContract
  const plan = resolveStripeSubscriptionPlanId({
    priceId: subscription.items?.data?.[0]?.price?.id,
    metadataPlan,
    billingContractVersion: effectiveBillingContract,
  })
  if (expected.planId && plan !== expected.planId) {
    throw new Error("Stripe subscription price does not match the reserved Maintain Flow plan.")
  }
  const stripeSubscriptionStatus = normalizeStripeSubscriptionStatus(subscription.status)
  const entitledPlan = plan
    ? entitledPlanForStripeStatus(plan, stripeSubscriptionStatus)
    : "free"
  const trialEndsAt = stripeTimestampToIso(subscription.trial_end)
  const billingContractVersion = subscriptionBillingContract === businessEvalsBillingContractVersion
    ? businessEvalsBillingContractVersion
    : undefined

  if (agencyId) {
    await updateAgencyBilling(agencyId, {
      plan: entitledPlan,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripeSubscriptionStatus: stripeSubscriptionStatus || null,
      trialEndsAt,
      billingContractVersion,
    })
  } else {
    await updateAgencyBillingByStripeReference({
      subscriptionId,
      customerId,
      plan: entitledPlan,
      trialEndsAt,
      stripeSubscriptionStatus: stripeSubscriptionStatus || null,
      billingContractVersion,
    })
  }

  return {
    agencyId,
    customerId,
    subscriptionId,
    planId: plan,
    entitledPlanId: entitledPlan,
    subscriptionStatus: stripeSubscriptionStatus,
    grantsPaidAccess: Boolean(plan && entitledPlan === plan),
  }
}

function valueOrEmpty(value: unknown) {
  return typeof value === "string" ? value : ""
}

function stripeTimestampToIso(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
}
