import "server-only"

import { businessEvalsBillingContractVersion, cardFreeWorkspaceTrialDays, type BillingPlanId, type BillingContractVersion } from "@/lib/billing/plans"
import type { StripeSubscriptionStatus } from "@/lib/core/types"
import { getSupabaseServerConfig, supabaseServiceJson } from "@/lib/supabase/server"

type SupabaseUser = {
  id: string
  email?: string
}

type MembershipRow = {
  agency_id: string
  user_id: string
  role: "owner" | "admin" | "member"
}

type AgencyBillingRow = {
  id: string
  name: string
  plan: BillingPlanId
  trial_ends_at: string | null
  team_trial_started_at: string | null
  team_trial_ends_at: string | null
  team_trial_used_at: string | null
  billing_contract_version: BillingContractVersion | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_subscription_status: StripeSubscriptionStatus | null
  complimentary_entitlement: boolean
  complimentary_entitlement_reason: string | null
}

export type BillingWorkspace = {
  user: SupabaseUser
  membershipRole: MembershipRow["role"]
  agency: {
    id: string
    name: string
    plan: BillingPlanId
    trialEndsAt: string
    teamTrialStartedAt: string
    teamTrialEndsAt: string
    teamTrialUsedAt: string
    billingContractVersion: BillingContractVersion
    stripeCustomerId: string
    stripeSubscriptionId: string
    stripeSubscriptionStatus: StripeSubscriptionStatus | ""
    complimentaryEntitlement: boolean
    complimentaryEntitlementReason: string
  }
}

export class BillingAuthenticationError extends Error {}
export class BillingAuthorizationError extends Error {}
export class BillingWorkspaceRequiredError extends Error {}

export function assertBillingAdmin(workspace: BillingWorkspace) {
  if (workspace.membershipRole !== "owner" && workspace.membershipRole !== "admin") {
    throw new BillingAuthorizationError("Only a workspace owner or admin can change billing.")
  }
}

export async function loadBillingWorkspaceForToken(token: string, requestedAgencyId?: string | null): Promise<BillingWorkspace> {
  const user = await verifySupabaseUser(token)
  const agencyId = requestedAgencyId?.trim() ?? ""
  if (!agencyId) {
    throw new BillingWorkspaceRequiredError("Select a billing workspace before continuing.")
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agencyId)) {
    throw new BillingWorkspaceRequiredError("Select a valid billing workspace.")
  }
  const memberships = await supabaseServiceJson<MembershipRow[]>(
    `memberships?${query({
      select: "agency_id,user_id,role",
      user_id: `eq.${user.id}`,
      agency_id: `eq.${agencyId}`,
      order: "created_at.asc",
      limit: "1",
    })}`
  )
  const membership = memberships[0]
  if (!membership?.agency_id) {
    throw new BillingWorkspaceRequiredError("Create a Maintain Flow workspace before opening billing.")
  }

  const agencies = await supabaseServiceJson<AgencyBillingRow[]>(
    `agencies?${query({
      select: "id,name,plan,trial_ends_at,team_trial_started_at,team_trial_ends_at,team_trial_used_at,billing_contract_version,stripe_customer_id,stripe_subscription_id,stripe_subscription_status,complimentary_entitlement,complimentary_entitlement_reason",
      id: `eq.${membership.agency_id}`,
      limit: "1",
    })}`
  )
  const agency = agencies[0]
  if (!agency?.id) {
    throw new BillingWorkspaceRequiredError("Billing workspace was not found.")
  }

  return {
    user,
    membershipRole: membership.role,
    agency: {
      id: agency.id,
      name: agency.name,
      plan: agency.plan,
      trialEndsAt: agency.trial_ends_at ?? "",
      teamTrialStartedAt: agency.team_trial_started_at ?? "",
      teamTrialEndsAt: agency.team_trial_ends_at ?? "",
      teamTrialUsedAt: agency.team_trial_used_at ?? "",
      billingContractVersion: agency.billing_contract_version === businessEvalsBillingContractVersion ? businessEvalsBillingContractVersion : "legacy",
      stripeCustomerId: agency.stripe_customer_id ?? "",
      stripeSubscriptionId: agency.stripe_subscription_id ?? "",
      stripeSubscriptionStatus: agency.stripe_subscription_status ?? "",
      complimentaryEntitlement: agency.complimentary_entitlement,
      complimentaryEntitlementReason: agency.complimentary_entitlement_reason ?? "",
    },
  }
}

export async function updateAgencyBilling(agencyId: string, input: {
  plan?: BillingPlanId
  trialEndsAt?: string | null
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  stripeSubscriptionStatus?: StripeSubscriptionStatus | null
  billingContractVersion?: BillingContractVersion
}) {
  const row: Record<string, string | null> = {}

  if (input.plan) row.plan = input.plan
  if (input.trialEndsAt !== undefined) row.trial_ends_at = input.trialEndsAt || null
  if (input.stripeCustomerId !== undefined) row.stripe_customer_id = input.stripeCustomerId || null
  if (input.stripeSubscriptionId !== undefined) row.stripe_subscription_id = input.stripeSubscriptionId || null
  if (input.stripeSubscriptionStatus !== undefined) row.stripe_subscription_status = input.stripeSubscriptionStatus || null
  if (input.billingContractVersion !== undefined) row.billing_contract_version = input.billingContractVersion

  if (!Object.keys(row).length) return

  const filters: Record<string, string> = { id: `eq.${agencyId}` }
  if (input.plan === "free") filters.complimentary_entitlement = "eq.false"

  await supabaseServiceJson(`agencies?${query(filters)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(row),
  })
}

export async function loadAgencyBillingContractVersionByStripeReference(input: {
  agencyId?: string
  customerId?: string
  subscriptionId?: string
}): Promise<BillingContractVersion | null> {
  const filters: Record<string, string> = {
    select: "billing_contract_version",
    limit: "1",
  }
  if (input.agencyId) {
    filters.id = `eq.${input.agencyId}`
  } else if (input.subscriptionId) {
    filters.stripe_subscription_id = `eq.${input.subscriptionId}`
  } else if (input.customerId) {
    filters.stripe_customer_id = `eq.${input.customerId}`
  } else {
    return null
  }

  const rows = await supabaseServiceJson<Array<{ billing_contract_version?: string | null }>>(
    `agencies?${query(filters)}`
  )
  const version = rows[0]?.billing_contract_version
  return version === "legacy" || version === businessEvalsBillingContractVersion ? version : null
}

export async function updateAgencyBillingByStripeReference(input: {
  customerId?: string
  subscriptionId?: string
  plan?: BillingPlanId
  trialEndsAt?: string | null
  stripeSubscriptionStatus?: StripeSubscriptionStatus | null
  billingContractVersion?: BillingContractVersion
  clearSubscription?: boolean
}) {
  const filters: string[] = []
  if (input.subscriptionId) {
    filters.push(`stripe_subscription_id.eq.${input.subscriptionId}`)
  } else if (input.customerId) {
    filters.push(`stripe_customer_id.eq.${input.customerId}`)
  }
  if (!filters.length) return

  const row: Record<string, string | null> = {}
  if (input.plan) row.plan = input.plan
  if (input.trialEndsAt !== undefined) row.trial_ends_at = input.trialEndsAt || null
  if (input.stripeSubscriptionStatus !== undefined) row.stripe_subscription_status = input.stripeSubscriptionStatus || null
  if (input.billingContractVersion !== undefined) row.billing_contract_version = input.billingContractVersion
  if (input.customerId) row.stripe_customer_id = input.customerId
  if (input.subscriptionId) row.stripe_subscription_id = input.clearSubscription ? null : input.subscriptionId

  const queryFilters: Record<string, string> = { or: `(${filters.join(",")})` }
  if (input.plan === "free") queryFilters.complimentary_entitlement = "eq.false"

  await supabaseServiceJson(`agencies?${query(queryFilters)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(row),
  })
}

export async function startCardFreeTeamTrial(agencyId: string) {
  const now = new Date()
  const endsAt = new Date(now.getTime() + cardFreeWorkspaceTrialDays * 86_400_000)
  const rows = await supabaseServiceJson<AgencyBillingRow[]>(`agencies?${query({
    id: `eq.${agencyId}`,
    team_trial_used_at: "is.null",
    stripe_subscription_id: "is.null",
    select: "id,team_trial_started_at,team_trial_ends_at,team_trial_used_at",
  })}`, {
    method: "PATCH",
    body: JSON.stringify({
      team_trial_started_at: now.toISOString(),
      team_trial_ends_at: endsAt.toISOString(),
      team_trial_used_at: now.toISOString(),
    }),
  })
  if (!rows[0]) throw new BillingWorkspaceRequiredError("This workspace has already used its Team trial or has an active subscription.")
  return {
    startedAt: rows[0].team_trial_started_at ?? now.toISOString(),
    endsAt: rows[0].team_trial_ends_at ?? endsAt.toISOString(),
  }
}

async function verifySupabaseUser(token: string): Promise<SupabaseUser> {
  const config = getSupabaseServerConfig()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  if (!anonKey) {
    throw new BillingAuthenticationError("Billing authentication is not configured.")
  }

  const response = await fetch(`${config.authUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
    },
  })
  const user = (await response.json().catch(() => ({}))) as SupabaseUser & { msg?: string; error?: string }

  if (!response.ok || !user.id) {
    throw new BillingAuthenticationError(user.msg || user.error || "Sign in again before opening billing.")
  }

  return user
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
