import "server-only"

import { isIP } from "node:net"

import type { ProjectCreateInput, ProjectUpdateInput } from "@/lib/api/business-evals-contracts"
import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { getBusinessEvalsEntitlement } from "@/lib/api/business-evals-entitlements.server"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export type ProjectSummary = {
  id: string
  name: string
  website: string
  kind: string
  health: "healthy" | "degraded" | "failed" | "pending"
  activeJourneys: number
  legacyEndpointJourneys: number
  businessEvalJourneys: number
  openIncidents: number
  lastRunAt: string | null
  ownerUserId: string | null
  ownerName: string
  ownerEmail: string
  reportStatus: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export async function listProjects(input: {
  agencyId: string
  limit: number
  cursor?: string
  search?: string
}) {
  const offset = decodeCursor(input.cursor)
  const filters: Record<string, string> = {
    select: "id,name,website,project_kind,owner_user_id,archived_at,created_at,updated_at",
    agency_id: `eq.${input.agencyId}`,
    archived_at: "is.null",
    order: "created_at.desc,id.desc",
    limit: String(input.limit),
    offset: String(offset),
  }
  const search = safeSearch(input.search)
  if (search) filters.or = `(name.ilike.*${search}*,website.ilike.*${search}*)`

  const projects = await supabaseServiceJson<Row[]>(`clients?${query(filters)}`)
  const summaries = await hydrateProjectSummaries(input.agencyId, projects)
  return {
    projects: summaries,
    nextCursor: projects.length === input.limit ? encodeCursor(offset + projects.length) : null,
  }
}

export async function getProject(agencyId: string, projectId: string) {
  const rows = await supabaseServiceJson<Row[]>(`clients?${query({
    select: "id,name,website,project_kind,owner_user_id,report_recipient_email,report_cadence,notes,archived_at,created_at,updated_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${projectId}`,
    limit: "1",
  })}`)
  if (!rows[0]) throw new BusinessEvalsApiError(404, "PROJECT_NOT_FOUND", "Project not found.")
  const [[summary], authorization] = await Promise.all([
    hydrateProjectSummaries(agencyId, rows),
    getLatestProjectAuthorization(agencyId, projectId),
  ])
  return {
    ...summary,
    reportRecipientEmail: String(rows[0].report_recipient_email ?? ""),
    reportCadence: String(rows[0].report_cadence ?? "monthly"),
    notes: String(rows[0].notes ?? ""),
    authorization,
  }
}

export async function createProject(agencyId: string, userId: string, input: ProjectCreateInput) {
  const ownerUserId = input.ownerUserId ?? userId
  await assertWorkspaceOwner(agencyId, ownerUserId)
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  const id = crypto.randomUUID()
  const slug = `${slugify(input.name)}-${id.slice(0, 6)}`
  let rows: Row[]
  try {
    rows = await supabaseServiceJson<Row[]>("rpc/create_business_eval_project", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: agencyId,
        p_project_limit: entitlement.projectLimit,
        p_project_id: id,
        p_name: input.name,
        p_slug: slug,
        p_website: input.website,
        p_project_kind: input.kind,
        p_owner_user_id: ownerUserId,
        p_report_recipient_email: input.reportRecipientEmail || "",
        p_notes: input.notes,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes("PROJECT_LIMIT_REACHED")) {
      throw new BusinessEvalsApiError(409, "PROJECT_LIMIT_REACHED", `${entitlement.publicPlan === "free" ? "Free" : "This plan"} supports ${entitlement.projectLimit} active project${entitlement.projectLimit === 1 ? "" : "s"}.`)
    }
    throw error
  }
  if (!rows[0]) throw new Error("Supabase did not return the created project.")
  return getProject(agencyId, id)
}

export async function updateProject(agencyId: string, projectId: string, input: ProjectUpdateInput) {
  const current = input.website !== undefined || input.archived !== undefined
    ? await getProject(agencyId, projectId)
    : null
  const websiteHostChanged = input.website !== undefined && current
    ? projectWebsiteHost(current.website) !== projectWebsiteHost(input.website)
    : false
  if (websiteHostChanged || input.archived === true) {
    // Fail safe before changing the project hostname: revoke the exact owner
    // attestation and pause browser schedules first, so a partial update cannot
    // leave an old authorization running against a changed or archived project.
    await supabaseServiceJson("rpc/revoke_project_authorizations_and_pause", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: agencyId,
        p_client_id: projectId,
      }),
    })
  }
  let restoredWithQuotaLock = false
  if (input.archived === false && current?.archivedAt) {
    const entitlement = await getBusinessEvalsEntitlement(agencyId)
    try {
      const restored = await supabaseServiceJson<Row[]>("rpc/restore_business_eval_project", {
        method: "POST",
        body: JSON.stringify({
          p_agency_id: agencyId,
          p_client_id: projectId,
          p_project_limit: entitlement.projectLimit,
          p_journey_limit: entitlement.journeyLimit,
        }),
      })
      if (!restored[0]) throw new Error("Supabase did not return the restored project.")
      restoredWithQuotaLock = true
    } catch (error) {
      if (error instanceof Error && error.message.includes("PROJECT_LIMIT_REACHED")) {
        throw new BusinessEvalsApiError(409, "PROJECT_LIMIT_REACHED", `${entitlement.publicPlan === "free" ? "Free" : "This plan"} supports ${entitlement.projectLimit} active project${entitlement.projectLimit === 1 ? "" : "s"}.`)
      }
      if (error instanceof Error && error.message.includes("JOURNEY_LIMIT_REACHED")) {
        throw new BusinessEvalsApiError(409, "JOURNEY_LIMIT_REACHED", "Archive journeys in this project before restoring it under the current plan.")
      }
      throw error
    }
  }
  const patch: Record<string, unknown> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.website !== undefined) patch.website = input.website
  if (input.kind !== undefined) patch.project_kind = input.kind
  if (input.ownerUserId !== undefined) {
    await assertWorkspaceOwner(agencyId, input.ownerUserId)
    patch.owner_user_id = input.ownerUserId
  }
  if (input.reportRecipientEmail !== undefined) patch.report_recipient_email = input.reportRecipientEmail || null
  if (input.notes !== undefined) patch.notes = input.notes
  if (input.archived !== undefined && !restoredWithQuotaLock) patch.archived_at = input.archived ? new Date().toISOString() : null
  if (!Object.keys(patch).length) return getProject(agencyId, projectId)

  const rows = await supabaseServiceJson<Row[]>(`clients?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${projectId}`,
    select: "id",
  })}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
  if (!rows[0]) throw new BusinessEvalsApiError(404, "PROJECT_NOT_FOUND", "Project not found.")
  return getProject(agencyId, projectId)
}

export async function recordProjectAuthorization(input: {
  agencyId: string
  projectId: string
  userId: string
  domain: string
  attestationVersion: string
  approvedActionDomains: string[]
}) {
  const project = await getProject(input.agencyId, input.projectId)
  const projectHost = normalizeAttestedHost(new URL(project.website).hostname)
  const domain = normalizeAttestedHost(input.domain)
  if (domain !== projectHost) {
    throw new BusinessEvalsApiError(400, "PROJECT_DOMAIN_MISMATCH", "The attested domain must match the project's public website.")
  }
  const approvedActionDomains = input.approvedActionDomains.map(normalizeAttestedHost)
  const rows = await supabaseServiceJson<Row[]>("rpc/record_project_authorization", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_client_id: input.projectId,
      p_attested_by_user_id: input.userId,
      p_hostname: domain,
      p_attestation_version: input.attestationVersion,
      p_approved_action_domains: [...new Set([domain, ...approvedActionDomains])],
    }),
  })
  if (!rows[0]) throw new Error("Supabase did not record the immutable project authorization.")
  return rows[0]
}

export async function getLatestProjectAuthorization(agencyId: string, projectId: string) {
  const rows = await supabaseServiceJson<Row[]>(`project_authorizations?${query({
    select: "id,hostname,approved_action_domains,attestation_version,attested_by_user_id,attested_at,revoked_at,created_at",
    agency_id: `eq.${agencyId}`,
    client_id: `eq.${projectId}`,
    order: "attested_at.desc,created_at.desc",
    limit: "1",
  })}`)
  const authorization = rows[0]
  if (!authorization) return null
  const actorUserId = String(authorization.attested_by_user_id ?? "")
  const profiles = actorUserId
    ? await supabaseServiceJson<Row[]>(`profiles?${query({
        select: "id,name,email",
        id: `eq.${actorUserId}`,
        limit: "1",
      })}`)
    : []
  const actor = profiles[0]
  const revokedAt = authorization.revoked_at ? String(authorization.revoked_at) : null
  return {
    id: String(authorization.id),
    domain: String(authorization.hostname ?? ""),
    approvedActionDomains: Array.isArray(authorization.approved_action_domains)
      ? authorization.approved_action_domains.map(String)
      : [],
    attestationVersion: String(authorization.attestation_version ?? ""),
    actor: {
      userId: actorUserId,
      name: String(actor?.name ?? "Workspace member"),
      email: String(actor?.email ?? ""),
    },
    recordedAt: String(authorization.attested_at ?? authorization.created_at ?? ""),
    revokedAt,
    state: revokedAt ? "revoked" as const : "current" as const,
  }
}

async function assertWorkspaceOwner(agencyId: string, userId: string) {
  const rows = await supabaseServiceJson<Row[]>(`memberships?${query({
    select: "user_id",
    agency_id: `eq.${agencyId}`,
    user_id: `eq.${userId}`,
    limit: "1",
  })}`)
  if (!rows[0]) throw new BusinessEvalsApiError(400, "OWNER_NOT_IN_WORKSPACE", "The project owner must be a workspace member.")
}

function normalizeAttestedHost(value: string) {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
  let hostname = ""
  try {
    hostname = new URL(`https://${normalized}`).hostname.toLowerCase()
  } catch {
    throw new BusinessEvalsApiError(400, "INVALID_DOMAIN", "A valid public domain is required.")
  }
  if (hostname !== normalized || isIP(hostname) || !hostname.includes(".")) {
    throw new BusinessEvalsApiError(400, "INVALID_DOMAIN", "A valid public domain name is required; IP targets are not supported.")
  }
  if (["localhost", "local", "internal", "home.arpa"].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)) || hostname === "metadata.google.internal") {
    throw new BusinessEvalsApiError(400, "INVALID_DOMAIN", "Private and internal domains cannot be authorized.")
  }
  return hostname
}

function projectWebsiteHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ""
  }
}

export async function assertProjectAuthorizedForUrl(agencyId: string, projectId: string, targetUrl: string) {
  const project = await getProject(agencyId, projectId)
  const targetHost = new URL(targetUrl).hostname.toLowerCase()
  const rows = await supabaseServiceJson<Row[]>(`project_authorizations?${query({
    select: "id,hostname,approved_action_domains,attestation_version,attested_at,revoked_at",
    agency_id: `eq.${agencyId}`,
    client_id: `eq.${projectId}`,
    revoked_at: "is.null",
    order: "attested_at.desc",
    limit: "1",
  })}`)
  const authorization = rows[0]
  if (!authorization) {
    throw new BusinessEvalsApiError(409, "PROJECT_AUTHORIZATION_REQUIRED", "Record the project owner attestation before scanning or running this site.")
  }
  const actionDomains = Array.isArray(authorization.approved_action_domains)
    ? authorization.approved_action_domains.map(String)
    : []
  const approved = new Set([String(authorization.hostname ?? "").toLowerCase(), ...actionDomains])
  if (![...approved].some((host) => targetHost === host || targetHost.endsWith(`.${host}`))) {
    throw new BusinessEvalsApiError(403, "DOMAIN_NOT_AUTHORIZED", `${targetHost} is not covered by this project authorization.`)
  }
  return { project, authorization, allowedHosts: [...approved].filter(Boolean) }
}

async function hydrateProjectSummaries(agencyId: string, projects: Row[]): Promise<ProjectSummary[]> {
  if (!projects.length) return []
  const ids = projects.map((row) => String(row.id))
  const ownerIds = [...new Set(projects.map((row) => String(row.owner_user_id ?? "")).filter(Boolean))]
  const [summaries, owners] = await Promise.all([
    supabaseServiceJson<Row[]>("rpc/get_business_eval_project_summaries", {
      method: "POST",
      body: JSON.stringify({ p_agency_id: agencyId, p_project_ids: ids }),
    }),
    ownerIds.length
      ? supabaseServiceJson<Row[]>(`profiles?${query({
          select: "id,name,email",
          id: `in.(${ownerIds.join(",")})`,
        })}`)
      : Promise.resolve([] as Row[]),
  ])
  const byProject = new Map(summaries.map((summary) => [String(summary.project_id), summary]))
  const ownerById = new Map(owners.map((owner) => [String(owner.id), owner]))

  return projects.map((project) => {
    const projectId = String(project.id)
    const summary = byProject.get(projectId) ?? {}
    const ownerUserId = project.owner_user_id ? String(project.owner_user_id) : null
    const owner = ownerUserId ? ownerById.get(ownerUserId) : undefined
    const lastRunAt = [summary.latest_eval_started_at, summary.latest_legacy_started_at]
      .filter(Boolean)
      .map(String)
      .sort((left, right) => timestampValue(right) - timestampValue(left))[0] ?? null
    const health = Boolean(summary.has_critical_incident)
      || summary.latest_eval_verdict === "failed"
      || Boolean(summary.has_failed_journey)
      ? "failed"
      : summary.latest_eval_verdict === "degraded" || Boolean(summary.has_degraded_journey)
        ? "degraded"
        : summary.latest_eval_verdict === "passed" || Boolean(summary.has_healthy_journey)
          ? "healthy"
          : "pending"

    return {
      id: projectId,
      name: String(project.name ?? "Untitled project"),
      website: String(project.website ?? ""),
      kind: String(project.project_kind ?? "client_site"),
      health,
      activeJourneys: Number(summary.active_journeys ?? 0),
      legacyEndpointJourneys: Number(summary.legacy_endpoint_journeys ?? 0),
      businessEvalJourneys: Number(summary.business_eval_journeys ?? 0),
      openIncidents: Number(summary.open_incidents ?? 0),
      lastRunAt,
      ownerUserId,
      ownerName: String(owner?.name ?? (ownerUserId ? "Workspace member" : "")),
      ownerEmail: String(owner?.email ?? ""),
      reportStatus: summary.latest_report_status ? String(summary.latest_report_status) : null,
      archivedAt: project.archived_at ? String(project.archived_at) : null,
      createdAt: String(project.created_at ?? ""),
      updatedAt: String(project.updated_at ?? ""),
    }
  })
}

function timestampValue(value: unknown) {
  const timestamp = new Date(String(value ?? "")).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project"
}

function safeSearch(value?: string) {
  return value?.replace(/[^a-z0-9 ._-]/gi, "").trim().slice(0, 80) ?? ""
}

function encodeCursor(offset: number) {
  return Buffer.from(String(offset)).toString("base64url")
}

function decodeCursor(cursor?: string) {
  if (!cursor) return 0
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"))
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
