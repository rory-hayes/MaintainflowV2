import type { BusinessEvalPlanFeatures } from "@/lib/billing/plans"

export type BusinessEvalJourneyEntitlementRequirement = {
  template: "lead_form" | "trial_signup" | "legacy_endpoint"
  emailProofConfigured: boolean
}

export type BusinessEvalJourneyEntitlementViolation = {
  code: "EMAIL_EVALS_PAID_PLAN_REQUIRED"
  message: string
}

export function businessEvalJourneyEntitlementViolation(
  requirement: BusinessEvalJourneyEntitlementRequirement,
  features: Pick<BusinessEvalPlanFeatures, "email">
): BusinessEvalJourneyEntitlementViolation | null {
  if (requirement.template === "legacy_endpoint") return null
  if ((requirement.template === "trial_signup" || requirement.emailProofConfigured) && !features.email) {
    return {
      code: "EMAIL_EVALS_PAID_PLAN_REQUIRED",
      message: "Email assertions and Trial signup journeys are available on Solo, Team and Agency plans.",
    }
  }
  return null
}
