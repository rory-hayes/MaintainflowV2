import "server-only"

import type { JourneyDraftInput } from "@/lib/api/business-evals-contracts"
import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import {
  assertBusinessEvalJourneyFeatureEntitlement,
  enforcePublishedJourneyFeatureEntitlement,
  getBusinessEvalsEntitlement,
} from "@/lib/api/business-evals-entitlements.server"
import { assertProjectAuthorizedForUrl, getProject } from "@/lib/api/projects.server"
import { createJourneyForwardingRecipient } from "@/lib/email/eval-inbound"
import {
  mergeLegacyEndpointHistory,
  presentLegacyEndpointRun,
} from "@/lib/evals/legacy-endpoint-compat"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export async function listJourneys(input: {
  agencyId: string
  limit: number
  cursor?: string
  search?: string
  status?: string
  projectId?: string
  includeArchived?: boolean
}) {
  const offset = decodeCursor(input.cursor)
  const filters: Record<string, string> = {
    select: "id,client_id,name,journey_template,status,draft_definition_json,active_journey_version_id,frequency_minutes,paused_at,pause_reason,last_check_run_at,archived_at,created_at,updated_at,clients!inner(archived_at)",
    agency_id: `eq.${input.agencyId}`,
    "clients.archived_at": "is.null",
    order: "created_at.desc,id.desc",
    limit: String(input.limit),
    offset: String(offset),
  }
  if (!input.includeArchived) filters.archived_at = "is.null"
  const search = safeSearch(input.search)
  if (search) filters.name = `ilike.*${search}*`
  const statusFilter = journeyStatusFilter(input.status)
  if (statusFilter) filters.status = statusFilter
  if (input.projectId) filters.client_id = `eq.${input.projectId}`
  const journeys = await supabaseServiceJson<Row[]>(`workflows?${query(filters)}`)
  const ids = journeys.map((row) => String(row.id))
  const summaries = ids.length
    ? await supabaseServiceJson<Row[]>("rpc/get_business_eval_journey_summaries", {
        method: "POST",
        body: JSON.stringify({ p_agency_id: input.agencyId, p_workflow_ids: ids }),
      })
    : []
  const summaryByJourney = new Map(summaries.map((summary) => [String(summary.workflow_id), summary]))

  return {
    journeys: journeys.map((row) => journeySummary(row, summaryByJourney.get(String(row.id)) ?? {})),
    nextCursor: journeys.length === input.limit ? encodeCursor(offset + journeys.length) : null,
  }
}

export async function getJourney(agencyId: string, journeyId: string) {
  const rows = await supabaseServiceJson<Row[]>(`workflows?${query({
    select: "id,client_id,name,journey_template,endpoint_url,status,draft_definition_json,draft_revision,active_journey_version_id,frequency_minutes,last_check_run_at,paused_at,pause_reason,archived_at,created_at,updated_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${journeyId}`,
    limit: "1",
  })}`)
  const journey = rows[0]
  if (!journey) throw new BusinessEvalsApiError(404, "JOURNEY_NOT_FOUND", "Journey not found.")
  const legacyEndpoint = String(journey.journey_template ?? "legacy_endpoint") === "legacy_endpoint"
  const [versions, schedules, runs, incidents, legacyChecks, legacyRuns] = await Promise.all([
    supabaseServiceJson<Row[]>(`journey_versions?${query({
      select: "id,version_number,template,definition_json,created_by_user_id,created_at",
      agency_id: `eq.${agencyId}`,
      workflow_id: `eq.${journeyId}`,
      order: "version_number.desc",
      limit: "20",
    })}`),
    supabaseServiceJson<Row[]>(`journey_schedules?${query({
      select: "id,enabled,interval_minutes,next_run_at,last_run_at,supervised_run_id,cleanup_verified,paused_at,pause_reason",
      agency_id: `eq.${agencyId}`,
      workflow_id: `eq.${journeyId}`,
      limit: "1",
    })}`),
    supabaseServiceJson<Row[]>(`eval_runs?${query({
      select: "id,journey_version_id,trigger_source,verdict,status,started_at,completed_at,duration_ms,created_at",
      agency_id: `eq.${agencyId}`,
      workflow_id: `eq.${journeyId}`,
      order: "created_at.desc",
      limit: "25",
    })}`),
    supabaseServiceJson<Row[]>(`issues?${query({
      select: "id,status,severity,title,eval_run_id,eval_stage_run_id,owner_user_id,updated_at",
      agency_id: `eq.${agencyId}`,
      workflow_id: `eq.${journeyId}`,
      order: "updated_at.desc",
      limit: "25",
    })}`),
    legacyEndpoint
      ? supabaseServiceJson<Row[]>(`checks?${query({
          select: "id,name,enabled,pending_setup,schedule_minutes,last_run_at,next_run_at",
          agency_id: `eq.${agencyId}`,
          workflow_id: `eq.${journeyId}`,
          order: "created_at.asc",
        })}`)
      : Promise.resolve([] as Row[]),
    legacyEndpoint
      ? supabaseServiceJson<Row[]>(`check_runs?${query({
          select: "id,client_id,workflow_id,check_id,evidence_origin,status,status_code,latency_ms,assertion_results_json,safe_response_summary,error_message,started_at,completed_at,created_at",
          agency_id: `eq.${agencyId}`,
          workflow_id: `eq.${journeyId}`,
          order: "created_at.desc,id.desc",
          limit: "25",
        })}`)
      : Promise.resolve([] as Row[]),
  ])
  const publishedVersion = versions.find((version) => String(version.id) === String(journey.active_journey_version_id ?? "")) ?? versions[0]
  const stages = !legacyEndpoint && publishedVersion
    ? await supabaseServiceJson<Row[]>(`journey_stage_definitions?${query({
        select: "id,stage_key,name,position,is_cleanup,action_manifest_json,expected_text,business_impact,timing_threshold_ms",
        agency_id: `eq.${agencyId}`,
        journey_version_id: `eq.${publishedVersion.id}`,
        order: "position.asc",
      })}`)
    : []
  const checkNames = new Map(legacyChecks.map((check) => [String(check.id), String(check.name ?? "Legacy endpoint check")]))
  const legacyHistory = legacyRuns.map((run) => presentLegacyEndpointRun(run, checkNames.get(String(run.check_id))))
  const enabledLegacyChecks = legacyChecks.filter((check) => check.enabled && !check.pending_setup)
  const legacyIntervals = enabledLegacyChecks.map((check) => Number(check.schedule_minutes)).filter((value) => Number.isFinite(value) && value > 0)
  const legacyNextRunAt = earliestTimestamp(enabledLegacyChecks.map((check) => check.next_run_at))
  const evalHistory = runs.map((run) => ({
    ...run,
    trigger: String(run.trigger_source),
    source: "business_eval" as const,
    stageEvidenceAvailable: true,
    startedAt: run.started_at ? String(run.started_at) : null,
    createdAt: String(run.created_at ?? ""),
  }))
  const history = mergeLegacyEndpointHistory(evalHistory, legacyHistory, 0, 25).rows
  const legacySchedule = legacyEndpoint ? {
    id: null,
    enabled: !journey.paused_at && !journey.archived_at && enabledLegacyChecks.length > 0,
    interval_minutes: legacyIntervals.length ? Math.min(...legacyIntervals) : Number(journey.frequency_minutes ?? 60),
    intervals_minutes: [...new Set(legacyIntervals)].sort((left, right) => left - right),
    check_count: legacyChecks.length,
    active_check_count: enabledLegacyChecks.length,
    next_run_at: legacyNextRunAt,
    last_run_at: journey.last_check_run_at ?? legacyChecks.find((check) => check.last_run_at)?.last_run_at ?? null,
    supervised_run_id: null,
    cleanup_verified: false,
    paused_at: journey.paused_at ?? null,
    pause_reason: journey.pause_reason ?? "",
    source: "legacy_endpoint",
  } : null
  return {
    id: String(journey.id),
    projectId: String(journey.client_id),
    name: String(journey.name),
    template: String(journey.journey_template ?? "legacy_endpoint"),
    startUrl: String(journey.endpoint_url ?? ""),
    status: journey.paused_at ? "paused" : String(journey.status ?? "pending"),
    draft: journey.draft_definition_json ?? {},
    draftRevision: Number(journey.draft_revision ?? 0),
    publishedVersionId: journey.active_journey_version_id ? String(journey.active_journey_version_id) : null,
    publishedVersion: legacyEndpoint ? null : publishedVersion ?? null,
    versions,
    stages,
    schedule: legacySchedule ?? schedules[0] ?? null,
    runs: history,
    incidents,
    source: legacyEndpoint ? "legacy_endpoint" : "business_eval",
    coverage: legacyEndpoint ? "Legacy endpoint" : "Business journey",
    stageEvidenceAvailable: !legacyEndpoint,
    legacyChecks,
    pausedAt: journey.paused_at ? String(journey.paused_at) : null,
    pauseReason: String(journey.pause_reason ?? ""),
    archivedAt: journey.archived_at ? String(journey.archived_at) : null,
    createdAt: String(journey.created_at ?? ""),
    updatedAt: String(journey.updated_at ?? ""),
  }
}

export async function getJourneyForwardingAddress(agencyId: string, journeyId: string) {
  const journey = await getJourney(agencyId, journeyId)
  return { forwardingRecipient: forwardedProofRecipient(journey.id, journey.draft) }
}

function forwardedProofRecipient(journeyId: unknown, definition: unknown) {
  const stages = isRecord(definition) && Array.isArray(definition.stages) ? definition.stages : []
  const usesForwarding = stages.some((stage) => isRecord(stage) && Array.isArray(stage.actions)
    && stage.actions.some((action) => isRecord(action)
      && action.type === "wait_for_email"
      && action.proofMode === "forwarded_marker"))
  if (!usesForwarding) return null
  const secret = process.env.EVAL_EMAIL_ROUTING_SECRET?.trim() ?? ""
  const domain = process.env.EVAL_INBOUND_DOMAIN?.trim() ?? ""
  if (secret.length < 32 || !domain) return null
  return createJourneyForwardingRecipient({ journeyId: String(journeyId), secret, domain })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function createJourneyDraft(agencyId: string, input: JourneyDraftInput) {
  if (input.draftRevision !== 0) {
    throw new BusinessEvalsApiError(400, "DRAFT_REVISION_INVALID", "New journeys must start at draft revision 0.")
  }
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  assertJourneyEntitlements(input, entitlement.features)
  await getProject(agencyId, input.projectId)
  await assertProjectAuthorizedForUrl(agencyId, input.projectId, input.startUrl)
  const id = crypto.randomUUID()
  let rows: Row[]
  try {
    rows = await supabaseServiceJson<Row[]>("rpc/create_business_eval_journey", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: agencyId,
        p_journey_limit: entitlement.journeyLimit,
        p_journey_id: id,
        p_client_id: input.projectId,
        p_name: input.name,
        p_template: input.template,
        p_start_url: input.startUrl,
        p_draft_definition: input,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes("JOURNEY_LIMIT_REACHED")) {
      throw new BusinessEvalsApiError(409, "JOURNEY_LIMIT_REACHED", `${entitlement.publicPlan === "free" ? "Free" : "This plan"} supports ${entitlement.journeyLimit} active journey${entitlement.journeyLimit === 1 ? "" : "s"}.`)
    }
    throw error
  }
  if (!rows[0]) throw new Error("Supabase did not return the created journey.")
  return getJourney(agencyId, id)
}

export async function updateJourneyDraft(agencyId: string, journeyId: string, input: JourneyDraftInput) {
  const current = await getJourney(agencyId, journeyId)
  assertJourneyNotArchived(current)
  if (current.projectId !== input.projectId) {
    throw new BusinessEvalsApiError(409, "JOURNEY_PROJECT_IMMUTABLE", "A journey cannot be moved between projects because its evidence history is project-bound.")
  }
  if (current.template !== input.template) {
    throw new BusinessEvalsApiError(409, "JOURNEY_TEMPLATE_IMMUTABLE", "Create a new journey to use a different launch template.")
  }
  if (current.draftRevision !== input.draftRevision) {
    throw new BusinessEvalsApiError(409, "DRAFT_VERSION_CONFLICT", "This journey draft changed in another session. Reload before publishing.")
  }
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  assertJourneyEntitlements(input, entitlement.features)
  await assertProjectAuthorizedForUrl(agencyId, input.projectId, input.startUrl)
  const rows = await supabaseServiceJson<Row[]>(`workflows?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${journeyId}`,
    draft_revision: `eq.${input.draftRevision}`,
    select: "id,draft_revision",
  })}`, {
    method: "PATCH",
    body: JSON.stringify({
      client_id: input.projectId,
      name: input.name,
      endpoint_url: input.startUrl,
      journey_template: input.template,
      draft_definition_json: { ...input, draftRevision: input.draftRevision + 1 },
      draft_revision: input.draftRevision + 1,
    }),
  })
  if (!rows[0]) throw new BusinessEvalsApiError(409, "DRAFT_VERSION_CONFLICT", "The draft changed before it could be saved.")
  return getJourney(agencyId, journeyId)
}

export async function publishJourney(input: {
  agencyId: string
  journeyId: string
  userId: string
  expectedDraftRevision: number
  supervisedRunId?: string
}) {
  const journey = await getJourney(input.agencyId, input.journeyId)
  assertJourneyNotArchived(journey)
  const authorization = await assertProjectAuthorizedForUrl(input.agencyId, journey.projectId, journey.startUrl)
  // Re-resolve billing after the draft and authorization reads. A workspace
  // can be downgraded while this builder is open; publication must use the
  // entitlement that exists immediately before the immutable version write.
  const currentEntitlement = await getBusinessEvalsEntitlement(input.agencyId)
  if (journey.template === "lead_form" || journey.template === "trial_signup") {
    assertJourneyEntitlements({
      template: journey.template,
      emailProofConfigured: isRecord(journey.draft) && journey.draft.emailProofConfigured === true,
    }, currentEntitlement.features)
  }
  const rows = await supabaseServiceJson<Row[]>("rpc/publish_journey_version", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_workflow_id: input.journeyId,
      p_expected_draft_revision: input.expectedDraftRevision,
      p_authorization_id: String(authorization.authorization.id),
      p_created_by_user_id: input.userId,
    }),
  })
  if (!rows[0]) throw new BusinessEvalsApiError(409, "PUBLISH_CONFLICT", "The journey could not be published from this draft revision.")
  const published = await getJourney(input.agencyId, input.journeyId)
  return {
    ...published,
    forwardingRecipient: forwardedProofRecipient(published.id, published.draft),
  }
}

export async function pauseJourney(agencyId: string, journeyId: string, reason: string) {
  const journey = await getJourney(agencyId, journeyId)
  assertJourneyNotArchived(journey)
  const now = new Date().toISOString()
  await Promise.all([
    supabaseServiceJson(`workflows?${query({ agency_id: `eq.${agencyId}`, id: `eq.${journeyId}` })}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ paused_at: now, pause_reason: reason.slice(0, 500) }),
    }),
    supabaseServiceJson(`journey_schedules?${query({ agency_id: `eq.${agencyId}`, workflow_id: `eq.${journeyId}` })}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ enabled: false, paused_at: now, pause_reason: reason.slice(0, 500) }),
    }),
  ])
  return getJourney(agencyId, journeyId)
}

const protectedPauseReasons = new Set([
  "cleanup_failed",
  "project_authorization_changed",
  "project_authorization_revoked",
])

/**
 * Resume only the journey execution lane. Existing schedules remain disabled
 * and proof-bound: configure_journey_schedule still requires a passing
 * supervised run for the active immutable version before it can enable one.
 * Safety pauses are deliberately not operator-clearable through this route.
 */
export async function resumeJourney(agencyId: string, journeyId: string) {
  const journey = await getJourney(agencyId, journeyId)
  assertJourneyNotArchived(journey)
  if (!journey.pausedAt) return journey
  if (journey.pauseReason === "entitlement_lost") {
    const entitlement = await getBusinessEvalsEntitlement(agencyId)
    await enforcePublishedJourneyFeatureEntitlement({
      agencyId,
      journeyId,
      journeyVersionId: journey.publishedVersionId,
      entitlement,
    })
  }
  if (protectedPauseReasons.has(journey.pauseReason)) {
    throw new BusinessEvalsApiError(
      409,
      "JOURNEY_SAFETY_PAUSE_ACTIVE",
      journey.pauseReason === "cleanup_failed"
        ? "Publish the repaired journey version before resuming after a cleanup failure."
        : "Record a current project authorization before this safety pause can be cleared."
    )
  }

  const rows = await supabaseServiceJson<Row[]>(`workflows?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${journeyId}`,
    paused_at: "not.is.null",
    select: "id",
  })}`, {
    method: "PATCH",
    body: JSON.stringify({ paused_at: null, pause_reason: "", updated_at: new Date().toISOString() }),
  })
  if (!rows[0]) {
    throw new BusinessEvalsApiError(409, "JOURNEY_RESUME_CONFLICT", "The journey pause changed before it could be resumed.")
  }
  return getJourney(agencyId, journeyId)
}

export async function configureJourneySchedule(input: {
  agencyId: string
  journeyId: string
  enabled: boolean
  intervalMinutes: number
}) {
  const journey = await getJourney(input.agencyId, input.journeyId)
  assertJourneyNotArchived(journey)
  const floor = journey.template === "trial_signup" ? 360 : 60
  if (input.intervalMinutes < floor) {
    throw new BusinessEvalsApiError(400, "UNSAFE_SCHEDULE", `${journey.template === "trial_signup" ? "Trial signup" : "Lead form"} journeys cannot run more frequently than every ${floor / 60} hour${floor === 60 ? "" : "s"}.`)
  }
  if (input.enabled && !journey.publishedVersionId) {
    throw new BusinessEvalsApiError(409, "PUBLISH_REQUIRED", "Publish a tested journey version before scheduling.")
  }
  if (input.enabled) {
    const entitlement = await getBusinessEvalsEntitlement(input.agencyId)
    await enforcePublishedJourneyFeatureEntitlement({
      agencyId: input.agencyId,
      journeyId: input.journeyId,
      journeyVersionId: journey.publishedVersionId,
      entitlement,
    })
    if (journey.status === "paused") {
      throw new BusinessEvalsApiError(409, "JOURNEY_PAUSED", "Resume this journey before enabling its schedule.")
    }
  }
  const rows = await supabaseServiceJson<Row[]>("rpc/configure_journey_schedule", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_workflow_id: input.journeyId,
      p_expected_draft_revision: journey.draftRevision,
      p_interval_minutes: input.intervalMinutes,
      p_enabled: input.enabled,
      p_next_run_at: null,
    }),
  })
  if (!rows[0]) throw new BusinessEvalsApiError(409, "SCHEDULE_BLOCKED", "A passing supervised run and verified cleanup are required before scheduling.")
  return getJourney(input.agencyId, input.journeyId)
}

function journeySummary(row: Row, summary: Row) {
  const id = String(row.id)
  const template = String(row.journey_template ?? "legacy_endpoint")
  const legacyEndpoint = template === "legacy_endpoint"
  return {
    id,
    projectId: String(row.client_id),
    projectName: String(summary.project_name ?? "Historical project"),
    name: String(row.name),
    template,
    source: legacyEndpoint ? "legacy_endpoint" : "business_eval",
    coverage: template === "legacy_endpoint"
      ? "Legacy endpoint"
      : template === "trial_signup"
        ? "Browser + email + cleanup"
        : Boolean((row.draft_definition_json as Row | undefined)?.emailProofConfigured)
        ? "Browser + email"
        : "Browser only",
    status: row.paused_at ? "paused" : String(row.status ?? "pending"),
    schedule: legacyEndpoint
      ? summary.legacy_interval_minutes === null || summary.legacy_interval_minutes === undefined ? null : Number(summary.legacy_interval_minutes)
      : summary.schedule_enabled ? Number(summary.schedule_interval_minutes) : null,
    nextRunAt: legacyEndpoint
      ? summary.legacy_next_run_at ? String(summary.legacy_next_run_at) : null
      : summary.schedule_next_run_at ? String(summary.schedule_next_run_at) : null,
    lastRunAt: legacyEndpoint
      ? latestTimestamp([row.last_check_run_at, summary.legacy_last_run_at])
      : summary.latest_eval_started_at ? String(summary.latest_eval_started_at) : null,
    lastVerdict: legacyEndpoint
      ? legacyWorkflowVerdict(row.status)
      : summary.latest_eval_verdict ? String(summary.latest_eval_verdict) : null,
    published: Boolean(row.active_journey_version_id),
    pausedAt: row.paused_at ? String(row.paused_at) : null,
    pauseReason: String(row.pause_reason ?? ""),
    scheduleEnabled: legacyEndpoint
      ? Number(summary.active_legacy_check_count ?? 0) > 0 && !row.paused_at
      : Boolean(summary.schedule_enabled),
    supervisedRunId: summary.supervised_run_id ? String(summary.supervised_run_id) : null,
    cleanupVerified: Boolean(summary.cleanup_verified),
    schedulePausedAt: summary.schedule_paused_at ? String(summary.schedule_paused_at) : null,
    schedulePauseReason: String(summary.schedule_pause_reason ?? ""),
    archivedAt: row.archived_at ? String(row.archived_at) : null,
    stageEvidenceAvailable: !legacyEndpoint,
    legacyCheckCount: legacyEndpoint ? Number(summary.legacy_check_count ?? 0) : 0,
    activeLegacyCheckCount: legacyEndpoint ? Number(summary.active_legacy_check_count ?? 0) : 0,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

export async function archiveJourney(input: {
  agencyId: string
  journeyId: string
  actorUserId: string
}) {
  await setJourneyArchived({ ...input, archived: true, journeyLimit: null })
  return getJourney(input.agencyId, input.journeyId)
}

export async function restoreJourney(input: {
  agencyId: string
  journeyId: string
  actorUserId: string
}) {
  const entitlement = await getBusinessEvalsEntitlement(input.agencyId)
  await setJourneyArchived({
    ...input,
    archived: false,
    journeyLimit: entitlement.journeyLimit,
  })
  return getJourney(input.agencyId, input.journeyId)
}

async function setJourneyArchived(input: {
  agencyId: string
  journeyId: string
  actorUserId: string
  archived: boolean
  journeyLimit: number | null
}) {
  try {
    const rows = await supabaseServiceJson<Row[]>("rpc/set_business_eval_journey_archived", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: input.agencyId,
        p_workflow_id: input.journeyId,
        p_actor_user_id: input.actorUserId,
        p_archived: input.archived,
        p_journey_limit: input.journeyLimit,
      }),
    })
    if (!rows[0]) throw new BusinessEvalsApiError(404, "JOURNEY_NOT_FOUND", "Journey not found.")
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("JOURNEY_LIMIT_REACHED")) {
      throw new BusinessEvalsApiError(409, "JOURNEY_LIMIT_REACHED", "Archive another journey or change plan before restoring this journey.")
    }
    if (message.includes("PROJECT_ARCHIVED")) {
      throw new BusinessEvalsApiError(409, "PROJECT_ARCHIVED", "Restore the project before restoring one of its journeys.")
    }
    if (message.includes("WORKSPACE_ROLE_REQUIRED")) {
      throw new BusinessEvalsApiError(403, "ROLE_REQUIRED", "Only a workspace owner or administrator can archive or restore journeys.")
    }
    throw error
  }
}

function assertJourneyNotArchived(journey: { archivedAt?: string | null }) {
  if (journey.archivedAt) {
    throw new BusinessEvalsApiError(409, "JOURNEY_ARCHIVED", "Restore this journey before changing, publishing, scheduling or running it.")
  }
}

function journeyStatusFilter(status?: string) {
  if (!status || status === "all") return ""
  if (status === "passed") return "eq.healthy"
  if (status === "attention") return "in.(degraded,failed)"
  if (["pending", "healthy", "degraded", "failed"].includes(status)) return `eq.${status}`
  throw new BusinessEvalsApiError(400, "INVALID_JOURNEY_STATUS", "Use all, passed, attention, pending, healthy, degraded or failed.")
}

function legacyWorkflowVerdict(status: unknown) {
  if (status === "healthy") return "passed"
  if (status === "degraded" || status === "failed") return String(status)
  return "inconclusive"
}

function earliestTimestamp(values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0] ?? null
}

function latestTimestamp(values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null
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

function assertJourneyEntitlements(
  draft: Pick<JourneyDraftInput, "template" | "emailProofConfigured">,
  features: { email: boolean }
) {
  assertBusinessEvalJourneyFeatureEntitlement({
    template: draft.template,
    emailProofConfigured: draft.emailProofConfigured,
  }, features)
}
