import "server-only"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import {
  businessEvalJourneyEntitlementViolation,
  type BusinessEvalJourneyEntitlementRequirement,
} from "@/lib/billing/business-eval-journey-entitlement"
import { getEffectiveBillingPlan, resolveBillingEntitlement } from "@/lib/billing/entitlements"
import type { BusinessEvalPlanFeatures } from "@/lib/billing/plans"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export async function getBusinessEvalsEntitlement(agencyId: string) {
  const agencies = await supabaseServiceJson<Row[]>(`agencies?${new URLSearchParams({
    select: "plan,trial_ends_at,team_trial_ends_at,billing_contract_version,stripe_customer_id,stripe_subscription_id,stripe_subscription_status,complimentary_entitlement,complimentary_entitlement_reason,eval_run_monthly_limit_override",
    id: `eq.${agencyId}`,
    limit: "1",
  })}`)
  const agency = agencies[0]
  if (!agency) throw new BusinessEvalsApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.")

  // Business Evals must use the same fail-closed entitlement resolver as
  // checkout, alerts, and the billing UI. In particular, a stored paid plan is
  // not enough: Stripe linkage/status (or an explicit complimentary grant) is
  // required before paid capacity can be used.
  const billingInput = {
    plan: agency.plan,
    trialEndsAt: agency.trial_ends_at,
    teamTrialEndsAt: agency.team_trial_ends_at,
    billingContractVersion: agency.billing_contract_version,
    stripeCustomerId: agency.stripe_customer_id,
    stripeSubscriptionId: agency.stripe_subscription_id,
    stripeSubscriptionStatus: agency.stripe_subscription_status,
    complimentaryEntitlement: agency.complimentary_entitlement,
    complimentaryEntitlementReason: agency.complimentary_entitlement_reason,
  } as Parameters<typeof resolveBillingEntitlement>[0]
  const nowMs = Date.now()
  const entitlement = resolveBillingEntitlement(billingInput, nowMs)
  const plan = getEffectiveBillingPlan(billingInput, nowMs)
  const rawOverride = agency.eval_run_monthly_limit_override
  const override = rawOverride === null || rawOverride === undefined ? null : Number(rawOverride)
  const configuredRunLimit = entitlement.grantsPaidAccess
    && override !== null && Number.isSafeInteger(override) && override >= 0
    ? override
    : plan.businessEvalLimits.runsPerMonth

  return {
    planId: plan.id,
    publicPlan: plan.publicKey,
    entitlementState: entitlement.state,
    grandfathered: entitlement.grandfathered,
    teamTrialActive: entitlement.state === "workspace_trial",
    projectLimit: plan.businessEvalLimits.projects,
    journeyLimit: plan.businessEvalLimits.journeys,
    runLimit: configuredRunLimit,
    evidenceDays: plan.businessEvalLimits.evidenceRetentionDays ?? 365,
    seatLimit: plan.businessEvalLimits.seats,
    features: plan.features satisfies BusinessEvalPlanFeatures,
  }
}

export async function assertBusinessEvalsResourceCapacity(
  agencyId: string,
  entitlement: Awaited<ReturnType<typeof getBusinessEvalsEntitlement>>
) {
  if (entitlement.projectLimit === null && entitlement.journeyLimit === null) {
    return { projects: 0, journeys: 0 }
  }
  const projectFetchLimit = entitlement.projectLimit === null ? 1_000 : entitlement.projectLimit + 1
  const projects = await supabaseServiceJson<Row[]>(`clients?${new URLSearchParams({
    select: "id",
    agency_id: `eq.${agencyId}`,
    archived_at: "is.null",
    order: "created_at.asc,id.asc",
    limit: String(projectFetchLimit),
  })}`)
  if (entitlement.projectLimit !== null && projects.length > entitlement.projectLimit) {
    throw new BusinessEvalsApiError(
      409,
      "ACTIVE_PROJECT_LIMIT_EXCEEDED",
      `${planLabel(entitlement.publicPlan)} supports ${entitlement.projectLimit} active project${entitlement.projectLimit === 1 ? "" : "s"}. Archive projects before starting another eval.`
    )
  }

  const projectIds = projects.map((project) => String(project.id)).filter(Boolean)
  if (!projectIds.length) return { projects: 0, journeys: 0 }
  const journeyFetchLimit = entitlement.journeyLimit === null ? 1_000 : entitlement.journeyLimit + 1
  const journeys = await supabaseServiceJson<Row[]>(`workflows?${new URLSearchParams({
    select: "id",
    agency_id: `eq.${agencyId}`,
    client_id: `in.(${projectIds.join(",")})`,
    archived_at: "is.null",
    order: "created_at.asc,id.asc",
    limit: String(journeyFetchLimit),
  })}`)
  if (entitlement.journeyLimit !== null && journeys.length > entitlement.journeyLimit) {
    throw new BusinessEvalsApiError(
      409,
      "ACTIVE_JOURNEY_LIMIT_EXCEEDED",
      `${planLabel(entitlement.publicPlan)} supports ${entitlement.journeyLimit} active journey${entitlement.journeyLimit === 1 ? "" : "s"}. Archive journeys before starting another eval.`
    )
  }
  return { projects: projects.length, journeys: journeys.length }
}

export function assertBusinessEvalJourneyFeatureEntitlement(
  requirement: BusinessEvalJourneyEntitlementRequirement,
  features: Pick<BusinessEvalPlanFeatures, "email">
) {
  const violation = businessEvalJourneyEntitlementViolation(requirement, features)
  if (violation) throw new BusinessEvalsApiError(402, violation.code, violation.message)
}

export async function enforcePublishedJourneyFeatureEntitlement(input: {
  agencyId: string
  journeyId: string
  journeyVersionId?: string | null
  entitlement: Awaited<ReturnType<typeof getBusinessEvalsEntitlement>>
}) {
  const requirement = await loadPublishedJourneyEntitlementRequirement(input)
  const violation = businessEvalJourneyEntitlementViolation(requirement, input.entitlement.features)
  if (!violation) return requirement

  await supabaseServiceJson("rpc/pause_business_eval_journey_for_entitlement_loss", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_workflow_id: input.journeyId,
    }),
  })
  throw new BusinessEvalsApiError(402, violation.code, violation.message)
}

async function loadPublishedJourneyEntitlementRequirement(input: {
  agencyId: string
  journeyId: string
  journeyVersionId?: string | null
}): Promise<BusinessEvalJourneyEntitlementRequirement> {
  const workflows = await supabaseServiceJson<Row[]>(`workflows?${new URLSearchParams({
    select: "id,journey_template,active_journey_version_id,draft_definition_json",
    agency_id: `eq.${input.agencyId}`,
    id: `eq.${input.journeyId}`,
    archived_at: "is.null",
    limit: "1",
  })}`)
  const workflow = workflows[0]
  if (!workflow) throw new BusinessEvalsApiError(404, "JOURNEY_NOT_FOUND", "Journey not found.")

  const versionId = input.journeyVersionId || String(workflow.active_journey_version_id ?? "")
  let template = normalizedTemplate(workflow.journey_template)
  let definition = recordValue(workflow.draft_definition_json)
  if (versionId) {
    const versions = await supabaseServiceJson<Row[]>(`journey_versions?${new URLSearchParams({
      select: "id,template,definition_json",
      agency_id: `eq.${input.agencyId}`,
      workflow_id: `eq.${input.journeyId}`,
      id: `eq.${versionId}`,
      limit: "1",
    })}`)
    const version = versions[0]
    if (!version) {
      throw new BusinessEvalsApiError(409, "JOURNEY_VERSION_NOT_FOUND", "The immutable journey version is unavailable.")
    }
    template = normalizedTemplate(version.template ?? workflow.journey_template)
    definition = recordValue(version.definition_json)
  }
  return {
    template,
    emailProofConfigured: definition.emailProofConfigured === true,
  }
}

function normalizedTemplate(value: unknown): BusinessEvalJourneyEntitlementRequirement["template"] {
  if (value === "trial_signup" || value === "lead_form") return value
  return "legacy_endpoint"
}

function recordValue(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

function planLabel(plan: string) {
  return plan === "solo" ? "Solo" : plan === "team" ? "Team" : plan === "agency" ? "Agency" : plan === "legacy" ? "Legacy" : "Free"
}
