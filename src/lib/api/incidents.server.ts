import "server-only"

import type { z } from "zod"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import type { incidentMutationSchema } from "@/lib/api/business-evals-contracts"
import { isLegacyEndpointIncident } from "@/lib/evals/legacy-endpoint-compat"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>
type IncidentMutation = z.infer<typeof incidentMutationSchema>

export async function listIncidents(input: {
  agencyId: string
  limit: number
  cursor?: string
  status?: string
  journeyId?: string
  projectId?: string
}) {
  const offset = decodeCursor(input.cursor)
  const filters: Record<string, string> = {
    select: "id,client_id,workflow_id,check_run_id,check_id,verification_run_id,eval_run_id,eval_stage_run_id,severity,status,title,description,suggested_action,owner_user_id,occurrence_count,snoozed_until,repair_recorded_at,resolved_at,verification_eval_run_id,resolution_note,report_safe_summary,created_at,updated_at",
    agency_id: `eq.${input.agencyId}`,
    order: "updated_at.desc,id.desc",
    limit: String(input.limit),
    offset: String(offset),
  }
  if (input.status) filters.status = `eq.${input.status}`
  if (input.journeyId) filters.workflow_id = `eq.${input.journeyId}`
  if (input.projectId) filters.client_id = `eq.${input.projectId}`
  const rows = await supabaseServiceJson<Row[]>(`issues?${query(filters)}`)
  const journeyIds = [...new Set(rows.map((row) => String(row.workflow_id ?? "")).filter(Boolean))]
  const journeys = journeyIds.length
    ? await supabaseServiceJson<Row[]>(`workflows?${query({
        select: "id,name",
        agency_id: `eq.${input.agencyId}`,
        id: `in.(${journeyIds.join(",")})`,
      })}`)
    : []
  const journeyNames = new Map(journeys.map((journey) => [String(journey.id), String(journey.name ?? "Historical journey")]))
  return {
    incidents: rows.map((row) => ({
      ...presentIncident(row),
      journeyName: journeyNames.get(String(row.workflow_id)) ?? "Historical journey",
    })),
    nextCursor: rows.length === input.limit ? encodeCursor(offset + rows.length) : null,
  }
}

export async function getIncident(agencyId: string, incidentId: string) {
  const rows = await supabaseServiceJson<Row[]>(`issues?${query({
    select: "id,client_id,workflow_id,check_run_id,check_id,verification_run_id,eval_run_id,eval_stage_run_id,severity,status,title,description,suggested_action,owner_user_id,occurrence_count,snoozed_until,repair_recorded_at,resolved_at,verification_eval_run_id,resolution_note,report_safe_summary,created_at,updated_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${incidentId}`,
    limit: "1",
  })}`)
  const incident = rows[0]
  if (!incident) throw new BusinessEvalsApiError(404, "INCIDENT_NOT_FOUND", "Incident not found.")
  const [notes, journeys] = await Promise.all([
    supabaseServiceJson<Row[]>(`issue_notes?${query({
      select: "id,user_id,body,report_safe,created_at",
      agency_id: `eq.${agencyId}`,
      issue_id: `eq.${incidentId}`,
      order: "created_at.asc",
    })}`),
    supabaseServiceJson<Row[]>(`workflows?${query({
      select: "id,name,journey_template,archived_at",
      agency_id: `eq.${agencyId}`,
      id: `eq.${String(incident.workflow_id)}`,
      limit: "1",
    })}`),
  ])
  const journey = journeys[0]
  return {
    ...presentIncident(incident),
    notes,
    journeyName: String(journey?.name ?? "Historical journey"),
    journeySource: String(journey?.journey_template ?? "legacy_endpoint") === "legacy_endpoint" ? "legacy_endpoint" : "business_eval",
    journeyArchivedAt: journey?.archived_at ? String(journey.archived_at) : null,
  }
}

export async function mutateIncident(input: {
  agencyId: string
  incidentId: string
  userId: string
  mutation: Exclude<IncidentMutation, { action: "verify" }>
}) {
  const incident = await getIncident(input.agencyId, input.incidentId)
  const now = new Date().toISOString()
  const patch: Row = { updated_at: now }
  if (input.mutation.action === "assign") {
    const memberships = await supabaseServiceJson<Row[]>(`memberships?${query({
      select: "user_id",
      agency_id: `eq.${input.agencyId}`,
      user_id: `eq.${input.mutation.ownerUserId}`,
      limit: "1",
    })}`)
    if (!memberships[0]) throw new BusinessEvalsApiError(400, "OWNER_NOT_IN_WORKSPACE", "The incident owner must be a workspace member.")
    patch.owner_user_id = input.mutation.ownerUserId
  } else if (input.mutation.action === "snooze") {
    if (new Date(input.mutation.until).getTime() <= Date.now()) {
      throw new BusinessEvalsApiError(400, "SNOOZE_MUST_BE_FUTURE", "Choose a future time for this incident snooze.")
    }
    patch.status = "snoozed"
    patch.snoozed_until = input.mutation.until
  } else {
    patch.status = "in_review"
    patch.repair_recorded_at = now
    patch.resolved_at = null
    patch.verification_eval_run_id = null
    patch.verification_run_id = null
    patch.resolution_note = input.mutation.note
    patch.report_safe_summary = input.mutation.note
    patch.snoozed_until = null
    await supabaseServiceJson("issue_notes", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        agency_id: input.agencyId,
        issue_id: input.incidentId,
        user_id: input.userId,
        body: input.mutation.note,
        report_safe: true,
      }),
    })
  }
  const rows = await supabaseServiceJson<Row[]>(`issues?${query({
    agency_id: `eq.${input.agencyId}`,
    id: `eq.${input.incidentId}`,
    select: "id",
  })}`, { method: "PATCH", body: JSON.stringify(patch) })
  if (!rows[0]) throw new BusinessEvalsApiError(409, "INCIDENT_UPDATE_CONFLICT", "The incident changed before it could be updated.")
  return getIncident(input.agencyId, incident.id)
}

function presentIncident(row: Row) {
  const legacyEndpoint = isLegacyEndpointIncident(row)
  return {
    id: String(row.id),
    projectId: String(row.client_id),
    journeyId: String(row.workflow_id),
    evalRunId: row.eval_run_id ? String(row.eval_run_id) : null,
    evalStageRunId: row.eval_stage_run_id ? String(row.eval_stage_run_id) : null,
    legacyCheckRunId: row.check_run_id ? String(row.check_run_id) : null,
    legacyCheckId: row.check_id ? String(row.check_id) : null,
    source: legacyEndpoint ? "legacy_endpoint" as const : "business_eval" as const,
    stageEvidenceAvailable: !legacyEndpoint,
    severity: String(row.severity),
    status: String(row.status),
    title: String(row.title),
    description: String(row.description ?? ""),
    suggestedAction: String(row.suggested_action ?? ""),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    occurrenceCount: Number(row.occurrence_count ?? 1),
    snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null,
    repairRecordedAt: row.repair_recorded_at ? String(row.repair_recorded_at) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    verificationEvalRunId: row.verification_eval_run_id ? String(row.verification_eval_run_id) : null,
    verificationLegacyRunId: row.verification_run_id ? String(row.verification_run_id) : null,
    repairNote: String(row.resolution_note ?? ""),
    reportSafeSummary: String(row.report_safe_summary ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
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
