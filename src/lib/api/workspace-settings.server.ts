import "server-only"

import { Resend } from "resend"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { getBusinessEvalsEntitlement } from "@/lib/api/business-evals-entitlements.server"
import { annualBillingDiscountPercent } from "@/lib/billing/plans"
import { portalConfigReason } from "@/lib/billing/stripe"
import { getSupabaseServerConfig, supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>
type WorkspaceRole = "owner" | "admin" | "member"

export async function getWorkspaceSettings(agencyId: string) {
  const rows = await supabaseServiceJson<Row[]>(`agencies?${query({
    select: "id,name,slug,logo_url,primary_color,report_sender_name,report_sender_email,plan,updated_at",
    id: `eq.${agencyId}`,
    limit: "1",
  })}`)
  const workspace = rows[0]
  if (!workspace) throw new BusinessEvalsApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.")
  return presentWorkspace(workspace)
}

export async function updateWorkspaceSettings(input: {
  agencyId: string
  expectedUpdatedAt: string
  name: string
  reportSenderName: string
  reportSenderEmail: string
  primaryColor: string | null
}) {
  const rows = await supabaseServiceJson<Row[]>(`agencies?${query({
    id: `eq.${input.agencyId}`,
    updated_at: `eq.${input.expectedUpdatedAt}`,
    select: "id,name,slug,logo_url,primary_color,report_sender_name,report_sender_email,plan,updated_at",
  })}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: input.name,
      report_sender_name: input.reportSenderName,
      report_sender_email: input.reportSenderEmail || null,
      primary_color: input.primaryColor,
      updated_at: new Date().toISOString(),
    }),
  })
  if (!rows[0]) {
    throw new BusinessEvalsApiError(409, "WORKSPACE_VERSION_CONFLICT", "Workspace settings changed in another session. Reload before saving.")
  }
  return presentWorkspace(rows[0])
}

export async function listWorkspaceTeam(agencyId: string) {
  const [memberships, entitlement] = await Promise.all([
    supabaseServiceJson<Row[]>(`memberships?${query({
      select: "id,user_id,role,created_at",
      agency_id: `eq.${agencyId}`,
      order: "created_at.asc",
    })}`),
    getBusinessEvalsEntitlement(agencyId),
  ])
  const userIds = memberships.map((membership) => String(membership.user_id)).filter(Boolean)
  const profiles = userIds.length
    ? await supabaseServiceJson<Row[]>(`profiles?${query({
        select: "id,email,name,avatar_url",
        id: `in.(${userIds.join(",")})`,
      })}`)
    : []
  const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]))
  return {
    members: memberships.map((membership) => {
      const profile = profileById.get(String(membership.user_id))
      return {
        id: String(membership.id),
        userId: String(membership.user_id),
        role: String(membership.role) as WorkspaceRole,
        name: String(profile?.name ?? "Workspace member"),
        email: String(profile?.email ?? ""),
        avatarUrl: String(profile?.avatar_url ?? ""),
        joinedAt: String(membership.created_at ?? ""),
      }
    }),
    usage: {
      seatsUsed: memberships.length,
      seatLimit: entitlement.seatLimit,
      plan: planLabel(entitlement.publicPlan),
    },
  }
}

export async function getWorkspaceBillingSettings(agencyId: string) {
  const [entitlement, agencies, projects, journeys, runs, seats] = await Promise.all([
    getBusinessEvalsEntitlement(agencyId),
    supabaseServiceJson<Row[]>(`agencies?${query({
      select: "id,plan,team_trial_started_at,team_trial_ends_at,team_trial_used_at,billing_contract_version,stripe_customer_id,stripe_subscription_id,stripe_subscription_status",
      id: `eq.${agencyId}`,
      limit: "1",
    })}`),
    supabaseServiceCount("clients", { agency_id: `eq.${agencyId}`, archived_at: "is.null" }),
    supabaseServiceCount("workflows", {
      agency_id: `eq.${agencyId}`,
      archived_at: "is.null",
      "clients.archived_at": "is.null",
    }, "id,clients!inner(id)"),
    supabaseServiceCount("eval_runs", {
      agency_id: `eq.${agencyId}`,
      quota_counted: "eq.true",
      quota_period_start: `eq.${new Date().toISOString().slice(0, 7)}-01`,
    }),
    supabaseServiceCount("memberships", { agency_id: `eq.${agencyId}` }),
  ])
  const agency = agencies[0]
  if (!agency) throw new BusinessEvalsApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.")
  const portalReason = portalConfigReason(
    String(agency.stripe_customer_id ?? ""),
    "manage",
    String(agency.stripe_subscription_id ?? "")
  )
  return {
    plan: {
      id: entitlement.planId,
      publicKey: entitlement.publicPlan,
      name: planLabel(entitlement.publicPlan),
      state: entitlement.entitlementState,
      grandfathered: entitlement.grandfathered,
      annualDiscountPercent: annualBillingDiscountPercent,
    },
    usage: {
      projects: { used: projects, limit: entitlement.projectLimit },
      journeys: { used: journeys, limit: entitlement.journeyLimit },
      runs: { used: runs, limit: entitlement.runLimit },
      seats: { used: seats, limit: entitlement.seatLimit },
      evidenceRetentionDays: entitlement.evidenceDays,
    },
    features: entitlement.features,
    trial: {
      startedAt: agency.team_trial_started_at ? String(agency.team_trial_started_at) : null,
      endsAt: agency.team_trial_ends_at ? String(agency.team_trial_ends_at) : null,
      usedAt: agency.team_trial_used_at ? String(agency.team_trial_used_at) : null,
      active: entitlement.teamTrialActive,
    },
    subscription: {
      status: String(agency.stripe_subscription_status ?? ""),
      portalAvailable: !portalReason,
      portalUnavailableReason: portalReason || null,
    },
  }
}

export async function inviteWorkspaceTeamMember(input: {
  agencyId: string
  actorUserId: string
  actorRole: WorkspaceRole
  email: string
  role: "admin" | "member"
  origin: string
}) {
  if (input.actorRole !== "owner" && input.role === "admin") {
    throw new BusinessEvalsApiError(403, "OWNER_REQUIRED", "Only the workspace owner can invite an administrator.")
  }
  const entitlement = await getBusinessEvalsEntitlement(input.agencyId)
  const normalizedEmail = input.email.trim().toLowerCase()
  const origin = trustedAppOrigin(input.origin)
  const existingProfiles = await supabaseServiceJson<Row[]>(`profiles?${query({
    select: "id,email,name",
    email: `eq.${normalizedEmail}`,
    limit: "1",
  })}`)
  const existingUserId = existingProfiles[0]?.id ? String(existingProfiles[0].id) : ""
  if (existingUserId) {
    const existingMembership = await supabaseServiceJson<Row[]>(`memberships?${query({
      select: "id,user_id,role",
      agency_id: `eq.${input.agencyId}`,
      user_id: `eq.${existingUserId}`,
      limit: "1",
    })}`)
    if (existingMembership[0]) {
      return {
        membershipId: String(existingMembership[0].id),
        userId: existingUserId,
        email: normalizedEmail,
        role: String(existingMembership[0].role),
        invitationEmailSent: false,
      }
    }
  }
  if (entitlement.seatLimit !== null) {
    const occupied = await supabaseServiceJson<Row[]>(`memberships?${query({
      select: "id",
      agency_id: `eq.${input.agencyId}`,
      limit: String(entitlement.seatLimit),
    })}`)
    if (occupied.length >= entitlement.seatLimit) {
      throw new BusinessEvalsApiError(409, "SEAT_LIMIT_REACHED", `${planLabel(entitlement.publicPlan)} supports ${entitlement.seatLimit} seat${entitlement.seatLimit === 1 ? "" : "s"}.`)
    }
  }
  let invitedUserId = existingUserId
  let authUserCreated = false

  if (!invitedUserId) {
    const invited = await inviteSupabaseAuthUser(normalizedEmail, origin)
    invitedUserId = invited.id
    authUserCreated = true
    try {
      await supabaseServiceJson("profiles?on_conflict=id", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify({
          id: invited.id,
          email: normalizedEmail,
          name: invited.name || normalizedEmail.split("@")[0],
        }),
      })
    } catch (error) {
      await deleteSupabaseAuthUser(invitedUserId).catch(() => undefined)
      throw error
    }
  }

  try {
    const rows = await supabaseServiceJson<Row[]>("rpc/add_business_eval_workspace_member", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: input.agencyId,
        p_actor_user_id: input.actorUserId,
        p_invited_user_id: invitedUserId,
        p_role: input.role,
        p_seat_limit: entitlement.seatLimit,
      }),
    })
    if (!rows[0]) throw new Error("Supabase did not return the invited membership.")
    if (!authUserCreated) await notifyExistingUser(normalizedEmail, origin).catch(() => undefined)
    return {
      membershipId: String(rows[0].id),
      userId: invitedUserId,
      email: normalizedEmail,
      role: String(rows[0].role),
      invitationEmailSent: authUserCreated,
    }
  } catch (error) {
    if (authUserCreated) await deleteSupabaseAuthUser(invitedUserId).catch(() => undefined)
    const message = error instanceof Error ? error.message : ""
    if (message.includes("SEAT_LIMIT_REACHED")) {
      throw new BusinessEvalsApiError(409, "SEAT_LIMIT_REACHED", `${planLabel(entitlement.publicPlan)} supports ${entitlement.seatLimit} seat${entitlement.seatLimit === 1 ? "" : "s"}.`)
    }
    if (message.includes("USER_ALREADY_HAS_WORKSPACE")) {
      throw new BusinessEvalsApiError(409, "USER_ALREADY_HAS_WORKSPACE", "This account already belongs to a workspace.")
    }
    throw error
  }
}

export async function updateWorkspaceTeamMember(input: {
  agencyId: string
  actorUserId: string
  memberUserId: string
  role: "admin" | "member"
}) {
  const rows = await supabaseServiceJson<Row[]>("rpc/update_business_eval_workspace_member_role", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_actor_user_id: input.actorUserId,
      p_member_user_id: input.memberUserId,
      p_role: input.role,
    }),
  })
  if (!rows[0]) throw new BusinessEvalsApiError(404, "MEMBER_NOT_FOUND", "Workspace member not found.")
  return { userId: String(rows[0].user_id), role: String(rows[0].role) }
}

export async function removeWorkspaceTeamMember(input: {
  agencyId: string
  actorUserId: string
  memberUserId: string
}) {
  const rows = await supabaseServiceJson<Row[]>("rpc/remove_business_eval_workspace_member", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_actor_user_id: input.actorUserId,
      p_member_user_id: input.memberUserId,
    }),
  })
  if (!rows[0]?.removed) throw new BusinessEvalsApiError(404, "MEMBER_NOT_FOUND", "Workspace member not found.")
  return { removed: true, userId: input.memberUserId }
}

async function inviteSupabaseAuthUser(email: string, origin: string) {
  const config = getSupabaseServerConfig()
  const redirectTo = new URL("/reset-password", origin).toString()
  const response = await fetch(`${config.authUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: adminAuthHeaders(config.serviceRoleKey),
    body: JSON.stringify({ email, data: { invited_to_maintain_flow: true } }),
  })
  const payload = await response.json().catch(() => null) as Row | null
  const user = payload?.user && typeof payload.user === "object" ? payload.user as Row : payload
  if (!response.ok || !user?.id) {
    throw new BusinessEvalsApiError(409, "INVITE_NOT_SENT", safeAuthMessage(payload, "The invitation email could not be sent."))
  }
  const metadata = user.user_metadata as Row | undefined
  return { id: String(user.id), name: String(metadata?.name ?? "") }
}

async function deleteSupabaseAuthUser(userId: string) {
  const config = getSupabaseServerConfig()
  await fetch(`${config.authUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: adminAuthHeaders(config.serviceRoleKey),
  })
}

async function notifyExistingUser(email: string, origin: string) {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? ""
  const from = process.env.MAINTAINFLOW_ALERT_FROM_EMAIL?.trim() ?? ""
  if (!apiKey || !from) return
  await new Resend(apiKey).emails.send({
    from,
    to: [email],
    subject: "You were added to a Maintain Flow workspace",
    text: `You can sign in to the Maintain Flow workspace at ${new URL("/sign-in", origin).toString()}`,
  })
}

async function supabaseServiceCount(table: string, filters: Record<string, string>, select = "id") {
  const config = getSupabaseServerConfig()
  const response = await fetch(`${config.restUrl}/${table}?${query({ select, ...filters })}`, {
    method: "HEAD",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      Prefer: "count=exact",
    },
  })
  if (!response.ok) throw new Error("Workspace usage could not be counted.")
  const total = response.headers.get("content-range")?.split("/").at(-1)
  const count = Number(total)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Workspace usage count was unavailable.")
  return count
}

function presentWorkspace(row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    logoUrl: String(row.logo_url ?? ""),
    primaryColor: row.primary_color ? String(row.primary_color) : null,
    reportSenderName: String(row.report_sender_name ?? ""),
    reportSenderEmail: String(row.report_sender_email ?? ""),
    plan: String(row.plan),
    updatedAt: String(row.updated_at),
  }
}

function adminAuthHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  }
}

function safeAuthMessage(payload: Row | null, fallback: string) {
  const message = typeof payload?.msg === "string" ? payload.msg : typeof payload?.message === "string" ? payload.message : ""
  return message && !/token|secret|key/i.test(message) ? message.slice(0, 300) : fallback
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function planLabel(plan: string) {
  return plan === "solo" ? "Solo" : plan === "team" ? "Team" : plan === "agency" ? "Agency" : plan === "legacy" ? "Legacy" : "Free"
}

function trustedAppOrigin(requestOrigin: string) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || (process.env.NODE_ENV === "production" ? "https://www.maintainflow.io" : requestOrigin)
  const url = new URL(configured)
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("The production invitation origin must use HTTPS.")
  }
  return url.origin
}
