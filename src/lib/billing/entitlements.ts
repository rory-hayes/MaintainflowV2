import type { Agency, StripeSubscriptionStatus } from "../core/types.ts"
import {
  businessEvalsBillingContractVersion,
  cardFreeWorkspaceTrialPlanId,
  getBillingPlan,
  getLegacyBillingPlan,
  isBillingPlanId,
  isBusinessEvalsBillingContract,
  type BillingContractVersion,
  type BillingPlan,
  type BillingPlanId,
} from "./plans.ts"

export const stripeSubscriptionStatuses = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const satisfies readonly StripeSubscriptionStatus[]

export type BillingEntitlementState =
  | "free"
  | "workspace_trial"
  | "stripe_trial"
  | "active_subscription"
  | "past_due"
  | "cancelled"
  | "complimentary"
  | "invalid"

export type BillingEntitlement = {
  state: BillingEntitlementState
  effectivePlanId: BillingPlanId
  contractVersion: BillingContractVersion
  grandfathered: boolean
  label: string
  description: string
  grantsPaidAccess: boolean
}

type BillingEntitlementInput = Pick<
  Agency,
  | "plan"
  | "stripeCustomerId"
  | "stripeSubscriptionId"
  | "stripeSubscriptionStatus"
  | "complimentaryEntitlement"
  | "complimentaryEntitlementReason"
> & {
  trialEndsAt?: string | null
  teamTrialEndsAt?: string | null
  // The schema migration deliberately lands after this documentation/code layer.
  // Missing means the existing paid subscription remains grandfathered.
  billingContractVersion?: string | null
}

export function normalizeStripeSubscriptionStatus(value: unknown): StripeSubscriptionStatus | "" {
  return typeof value === "string" && stripeSubscriptionStatuses.includes(value as StripeSubscriptionStatus)
    ? (value as StripeSubscriptionStatus)
    : ""
}

export function stripeStatusGrantsPaidAccess(status: unknown) {
  const normalized = normalizeStripeSubscriptionStatus(status)
  return normalized === "trialing" || normalized === "active"
}

export function entitledPlanForStripeStatus(plan: unknown, status: unknown): BillingPlanId {
  if (typeof plan !== "string" || !isBillingPlanId(plan) || plan === "free" || plan === "agency_plus") {
    return "free"
  }

  return stripeStatusGrantsPaidAccess(status) ? plan : "free"
}

export function isCardFreeWorkspaceTrialActive(trialEndsAt: string | null | undefined, nowMs = Date.now()) {
  if (!trialEndsAt) return false
  const trialEndMs = Date.parse(trialEndsAt)
  return Number.isFinite(trialEndMs) && trialEndMs > nowMs
}

export function resolveBillingEntitlement(
  input: BillingEntitlementInput,
  nowMs = Date.now()
): BillingEntitlement {
  const storedPlan = getBillingPlan(input.plan).id
  const paidStoredPlan = storedPlan !== "free"
  const stripeEligibleStoredPlan = paidStoredPlan && storedPlan !== "agency_plus"
  const stripeStatus = normalizeStripeSubscriptionStatus(input.stripeSubscriptionStatus)
  const hasStripeLinkage = Boolean(input.stripeCustomerId && input.stripeSubscriptionId)
  const hasComplimentaryReason = Boolean(input.complimentaryEntitlementReason?.trim())
  const explicitlyMigrated = isBusinessEvalsBillingContract(input.billingContractVersion)
  const subscriptionContractVersion: BillingContractVersion = explicitlyMigrated
    ? businessEvalsBillingContractVersion
    : "legacy"
  const grandfathered = subscriptionContractVersion === "legacy"

  if (input.complimentaryEntitlement) {
    if (paidStoredPlan && hasComplimentaryReason) {
      return {
        state: "complimentary",
        effectivePlanId: storedPlan,
        contractVersion: storedPlan === "agency_plus" ? "legacy" : subscriptionContractVersion,
        grandfathered: storedPlan === "agency_plus" || grandfathered,
        label: storedPlan === "agency_plus" || grandfathered ? "Grandfathered complimentary access" : "Complimentary access",
        description: storedPlan === "agency_plus" || grandfathered
          ? "This explicit complimentary entitlement remains on its legacy contract until a recorded migration."
          : "This plan is an explicit Maintain Flow complimentary entitlement, not a Stripe subscription.",
        grantsPaidAccess: true,
      }
    }

    return invalidEntitlement()
  }

  if (stripeStatus === "trialing" && hasStripeLinkage && stripeEligibleStoredPlan) {
    return paidStripeEntitlement("stripe_trial", storedPlan, subscriptionContractVersion)
  }

  if (stripeStatus === "active" && hasStripeLinkage && stripeEligibleStoredPlan) {
    return paidStripeEntitlement("active_subscription", storedPlan, subscriptionContractVersion)
  }

  if (["past_due", "unpaid", "incomplete", "paused"].includes(stripeStatus)) {
    return {
      state: "past_due",
      effectivePlanId: "free",
      contractVersion: businessEvalsBillingContractVersion,
      grandfathered: false,
      label: "Payment needs attention",
      description: "Paid capacity is paused until the Stripe subscription returns to trialing or active.",
      grantsPaidAccess: false,
    }
  }

  if (stripeStatus === "canceled" || stripeStatus === "incomplete_expired") {
    return {
      state: "cancelled",
      effectivePlanId: "free",
      contractVersion: businessEvalsBillingContractVersion,
      grandfathered: false,
      label: "Cancelled",
      description: "The Stripe subscription is no longer active, so this workspace uses Free limits.",
      grantsPaidAccess: false,
    }
  }

  // A workspace trial has no Stripe linkage, never auto-charges, and always grants
  // the Team contract. Persisting the original trial end is the one-trial marker.
  if (
    !stripeStatus &&
    !hasStripeLinkage &&
    (storedPlan === "free" || storedPlan === cardFreeWorkspaceTrialPlanId) &&
    isCardFreeWorkspaceTrialActive(input.teamTrialEndsAt ?? input.trialEndsAt, nowMs)
  ) {
    return {
      state: "workspace_trial",
      effectivePlanId: cardFreeWorkspaceTrialPlanId,
      contractVersion: businessEvalsBillingContractVersion,
      grandfathered: false,
      label: "Team trial",
      description: "This workspace is using its one card-free 14-day Team trial. It returns to Free when the trial ends.",
      grantsPaidAccess: true,
    }
  }

  if (paidStoredPlan) return invalidEntitlement()

  return {
    state: "free",
    effectivePlanId: "free",
    contractVersion: businessEvalsBillingContractVersion,
    grandfathered: false,
    label: "Free",
    description: "No paid Stripe subscription, active workspace trial, or complimentary entitlement is attached to this workspace.",
    grantsPaidAccess: false,
  }
}

export function getEffectiveBillingPlan(input: BillingEntitlementInput, nowMs = Date.now()): BillingPlan {
  const entitlement = resolveBillingEntitlement(input, nowMs)
  return entitlement.grandfathered
    ? getLegacyBillingPlan(entitlement.effectivePlanId)
    : getBillingPlan(entitlement.effectivePlanId)
}

function paidStripeEntitlement(
  state: "stripe_trial" | "active_subscription",
  effectivePlanId: BillingPlanId,
  contractVersion: BillingContractVersion
): BillingEntitlement {
  const grandfathered = contractVersion === "legacy"
  const trial = state === "stripe_trial"
  return {
    state,
    effectivePlanId,
    contractVersion,
    grandfathered,
    label: grandfathered ? "Grandfathered subscription" : trial ? "Stripe trial" : "Active subscription",
    description: grandfathered
      ? "This subscription keeps its existing price and capacity until the workspace explicitly migrates."
      : trial
        ? "Stripe has confirmed a trialing subscription for this plan."
        : "Stripe has confirmed this paid subscription is active.",
    grantsPaidAccess: true,
  }
}

function invalidEntitlement(): BillingEntitlement {
  return {
    state: "invalid",
    effectivePlanId: "free",
    contractVersion: businessEvalsBillingContractVersion,
    grandfathered: false,
    label: "Entitlement needs attention",
    description: "The stored plan is not backed by an active Stripe subscription, active workspace trial, or explicit complimentary entitlement. Free limits apply.",
    grantsPaidAccess: false,
  }
}
