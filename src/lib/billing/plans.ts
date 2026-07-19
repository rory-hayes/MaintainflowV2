import type { Agency } from "../core/types.ts"

// Storage IDs are intentionally stable until the database enum and Stripe mappings
// are migrated. Customer-facing names are defined by `publicKey` and `name`.
export const billingPlanIds = ["free", "starter", "growth", "scale", "agency_plus"] as const
export const publicBillingPlanIds = ["free", "starter", "growth", "scale"] as const
export const checkoutBillingPlanIds = ["starter", "growth", "scale"] as const
export const billingIntervals = ["monthly", "annual"] as const
export const annualBillingDiscountPercent = 10
export const businessEvalsBillingContractVersion = "business_evals_v1" as const
export const cardFreeWorkspaceTrialDays = 14

export type BillingPlanId = (typeof billingPlanIds)[number]
export type PublicBillingPlanId = (typeof publicBillingPlanIds)[number]
export type CheckoutBillingPlanId = (typeof checkoutBillingPlanIds)[number]
export type BillingInterval = (typeof billingIntervals)[number]
export type BillingContractVersion = typeof businessEvalsBillingContractVersion | "legacy"

export const cardFreeWorkspaceTrialPlanId = "growth" as const satisfies BillingPlanId

// These keys keep the legacy Client/Workflow/Report runtime compatible while the
// Business Evals data model is rolled out. They intentionally retain the previous
// endpoint-assurance quotas; Business Evals gates must use `businessEvalLimits`
// and `features` instead of treating these transitional values as product limits.
export type BillingLimitKey = "clients" | "workflows" | "reportsPerMonth"

export type BusinessEvalLimitKey =
  | "projects"
  | "journeys"
  | "runsPerMonth"
  | "evidenceRetentionDays"
  | "seats"

export type BusinessEvalFeatureKey = "email" | "webhook" | "liveLink" | "pdf" | "whiteLabel"

export type BusinessEvalPlanLimits = Record<BusinessEvalLimitKey, number | null>
export type BusinessEvalPlanFeatures = Record<BusinessEvalFeatureKey, boolean>

export type BillingPlan = {
  id: BillingPlanId
  publicKey: "free" | "solo" | "team" | "agency" | "legacy"
  contractVersion: BillingContractVersion
  name: string
  price: string
  monthlyPriceEur: number | null
  description: string
  businessEvalLimits: BusinessEvalPlanLimits
  features: BusinessEvalPlanFeatures
  // Compatibility limits consumed by the pre-Business-Evals runtime.
  limits: Record<BillingLimitKey, number | null>
  workflowsPerClient: number | null
  checkoutEligible: boolean
  cardFreeTrialEligible: boolean
}

export type BillingUsage = Record<BillingLimitKey, number>
export type BusinessEvalUsage = Pick<BusinessEvalPlanLimits, "projects" | "journeys" | "runsPerMonth" | "seats">

const freeFeatures: BusinessEvalPlanFeatures = {
  email: false,
  webhook: false,
  liveLink: false,
  pdf: false,
  whiteLabel: false,
}

const paidFeatures: BusinessEvalPlanFeatures = {
  email: true,
  webhook: true,
  liveLink: true,
  pdf: true,
  whiteLabel: false,
}

export const billingPlans: Record<BillingPlanId, BillingPlan> = {
  free: {
    id: "free",
    publicKey: "free",
    contractVersion: businessEvalsBillingContractVersion,
    name: "Free",
    price: "€0/month",
    monthlyPriceEur: 0,
    description: "One project and one browser-only Lead form journey for proving the first repeatable business eval.",
    businessEvalLimits: { projects: 1, journeys: 1, runsPerMonth: 35, evidenceRetentionDays: 7, seats: 1 },
    features: freeFeatures,
    limits: { clients: 1, workflows: 3, reportsPerMonth: 1 },
    workflowsPerClient: 3,
    checkoutEligible: false,
    cardFreeTrialEligible: false,
  },
  starter: {
    id: "starter",
    publicKey: "solo",
    contractVersion: businessEvalsBillingContractVersion,
    name: "Solo",
    price: "€49/month",
    monthlyPriceEur: 49,
    description: "For one operator running recurring business evals across a small client portfolio.",
    businessEvalLimits: { projects: 3, journeys: 5, runsPerMonth: 750, evidenceRetentionDays: 30, seats: 2 },
    features: paidFeatures,
    limits: { clients: 3, workflows: 5, reportsPerMonth: null },
    workflowsPerClient: null,
    checkoutEligible: true,
    cardFreeTrialEligible: false,
  },
  growth: {
    id: "growth",
    publicKey: "team",
    contractVersion: businessEvalsBillingContractVersion,
    name: "Team",
    price: "€149/month",
    monthlyPriceEur: 149,
    description: "For teams operating a shared portfolio of deterministic browser and endpoint journeys.",
    businessEvalLimits: { projects: 15, journeys: 30, runsPerMonth: 7_500, evidenceRetentionDays: 90, seats: 5 },
    features: paidFeatures,
    limits: { clients: 15, workflows: 30, reportsPerMonth: null },
    workflowsPerClient: null,
    checkoutEligible: true,
    cardFreeTrialEligible: true,
  },
  scale: {
    id: "scale",
    publicKey: "agency",
    contractVersion: businessEvalsBillingContractVersion,
    name: "Agency",
    price: "€399/month",
    monthlyPriceEur: 399,
    description: "For agencies standardising business-eval evidence across a larger retained portfolio.",
    businessEvalLimits: { projects: 50, journeys: 100, runsPerMonth: 30_000, evidenceRetentionDays: 365, seats: 15 },
    features: { ...paidFeatures, whiteLabel: true },
    limits: { clients: 50, workflows: 100, reportsPerMonth: null },
    workflowsPerClient: null,
    checkoutEligible: true,
    cardFreeTrialEligible: false,
  },
  agency_plus: {
    id: "agency_plus",
    publicKey: "legacy",
    contractVersion: "legacy",
    name: "Agency+ (legacy)",
    price: "Legacy contract",
    monthlyPriceEur: null,
    description: "Grandfathered high-volume access retained until an explicit customer migration.",
    businessEvalLimits: { projects: null, journeys: null, runsPerMonth: null, evidenceRetentionDays: null, seats: null },
    features: { ...paidFeatures, whiteLabel: true },
    limits: { clients: null, workflows: null, reportsPerMonth: null },
    workflowsPerClient: null,
    checkoutEligible: false,
    cardFreeTrialEligible: false,
  },
}

// Existing paid subscriptions keep the plan and limits they bought. A later,
// explicit migration records `business_evals_v1` before target entitlements apply.
export const legacyBillingPlans: Record<Exclude<BillingPlanId, "free">, BillingPlan> = {
  starter: legacyPlan("starter", "Starter (legacy)", "€99/month", 99, 5, 50, 5, 10),
  growth: legacyPlan("growth", "Growth (legacy)", "€199/month", 199, 10, 100, 15, 10),
  scale: legacyPlan("scale", "Scale (legacy)", "€499/month", 499, 30, 300, 50, 10),
  agency_plus: billingPlans.agency_plus,
}

export function isBillingPlanId(value: string): value is BillingPlanId {
  return billingPlanIds.includes(value as BillingPlanId)
}

export function isBillingInterval(value: string): value is BillingInterval {
  return billingIntervals.includes(value as BillingInterval)
}

export function isBusinessEvalsBillingContract(value: unknown): value is typeof businessEvalsBillingContractVersion {
  return value === businessEvalsBillingContractVersion
}

export function getBillingPlan(plan: Agency["plan"] | string | null | undefined) {
  return isBillingPlanId(plan ?? "") ? billingPlans[plan as BillingPlanId] : billingPlans.free
}

export function getLegacyBillingPlan(plan: BillingPlanId) {
  return plan === "free" ? billingPlans.free : legacyBillingPlans[plan]
}

export function getBillingInterval(interval: string | null | undefined): BillingInterval {
  return isBillingInterval(interval ?? "") ? interval as BillingInterval : "monthly"
}

type SearchParamsReader = { get(name: string): string | null }

export function readCheckoutBillingSelection(params: SearchParamsReader): {
  plan: CheckoutBillingPlanId | null
  interval: BillingInterval
} {
  const plan = params.get("plan") ?? ""

  return {
    plan: checkoutBillingPlanIds.includes(plan as CheckoutBillingPlanId)
      ? plan as CheckoutBillingPlanId
      : null,
    interval: getBillingInterval(params.get("interval")),
  }
}

export function formatBillingLimit(limit: number | null) {
  return limit === null ? "Custom" : String(limit)
}

export function billingLimitPercent(used: number, limit: number | null) {
  if (limit === null) return 0
  return Math.min(100, Math.round((used / Math.max(limit, 1)) * 100))
}

export function billingMonthlyEquivalentEur(plan: BillingPlan, interval: BillingInterval) {
  if (plan.monthlyPriceEur === null) return null
  if (interval === "annual" && plan.checkoutEligible) {
    return plan.monthlyPriceEur * (1 - annualBillingDiscountPercent / 100)
  }
  return plan.monthlyPriceEur
}

export function billingAnnualTotalEur(plan: BillingPlan) {
  if (plan.monthlyPriceEur === null || !plan.checkoutEligible) return null
  return plan.monthlyPriceEur * 12 * (1 - annualBillingDiscountPercent / 100)
}

export function billingCheckoutUnitAmountCents(plan: BillingPlan, interval: BillingInterval) {
  if (!plan.checkoutEligible || plan.monthlyPriceEur === null) return null

  const amountEur = interval === "annual" ? billingAnnualTotalEur(plan) : plan.monthlyPriceEur
  return amountEur === null ? null : Math.round(amountEur * 100)
}

export function billingPriceDisplay(plan: BillingPlan, interval: BillingInterval) {
  const monthlyEquivalent = billingMonthlyEquivalentEur(plan, interval) ?? 0

  return {
    amount: formatEur(monthlyEquivalent),
    suffix: interval === "annual" && plan.checkoutEligible ? "/month equivalent" : "/month",
    note: interval === "annual" && plan.checkoutEligible
      ? `${formatEur(billingAnnualTotalEur(plan) ?? 0)} billed once per year after ${annualBillingDiscountPercent}% discount.`
      : plan.id === "free"
        ? `No card required. One ${cardFreeWorkspaceTrialDays}-day Team trial is available per workspace.`
        : "Billed monthly. The workspace trial does not restart at checkout.",
  }
}

export function formatEur(amount: number) {
  const hasCents = !Number.isInteger(amount)

  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(amount)
}

function legacyPlan(
  id: "starter" | "growth" | "scale",
  name: string,
  price: string,
  monthlyPriceEur: number,
  clients: number,
  workflows: number,
  reportsPerMonth: number,
  workflowsPerClient: number
): BillingPlan {
  return {
    id,
    publicKey: "legacy",
    contractVersion: "legacy",
    name,
    price,
    monthlyPriceEur,
    description: "Grandfathered subscription retained until the workspace explicitly migrates.",
    businessEvalLimits: {
      projects: clients,
      journeys: workflows,
      runsPerMonth: null,
      evidenceRetentionDays: null,
      seats: null,
    },
    features: { ...paidFeatures, whiteLabel: true },
    limits: { clients, workflows, reportsPerMonth },
    workflowsPerClient,
    checkoutEligible: false,
    cardFreeTrialEligible: false,
  }
}
