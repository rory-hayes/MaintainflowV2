import "server-only"

import { createHash } from "node:crypto"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import {
  assertBusinessEvalsResourceCapacity,
  enforcePublishedJourneyFeatureEntitlement,
  getBusinessEvalsEntitlement,
} from "@/lib/api/business-evals-entitlements.server"
import type { EvalRunInput } from "@/lib/api/business-evals-contracts"
import { getJourney } from "@/lib/api/journeys.server"
import { submittedMarkerForRun } from "@/lib/email/eval-inbound"
import {
  mergeLegacyEndpointHistory,
  presentLegacyEndpointRun,
} from "@/lib/evals/legacy-endpoint-compat"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { isBusinessEvalsRunnerEnabled } from "@/lib/features/business-evals"

type Row = Record<string, unknown>

export type EnqueuedEvalRun = {
  id: string
  trigger: EvalRunInput["mode"]
  enqueued: boolean
  quotaUsed: number
  quotaLimit: number | null
}

export async function enqueueEvalRunRecord(input: {
  agencyId: string
  userId: string
  idempotencyKey: string
  run: EvalRunInput
  scheduleId?: string | null
  scheduledFor?: string | null
}): Promise<EnqueuedEvalRun> {
  const replay = await findExistingEvalRunReplay({
    agencyId: input.agencyId,
    idempotencyKey: input.idempotencyKey,
    journeyId: input.run.journeyId,
    journeyVersionId: null,
    scheduleId: input.scheduleId ?? null,
    trigger: input.run.mode,
    scheduledFor: input.scheduledFor ?? null,
    requestedByUserId: input.userId,
    verificationIssueId: input.run.incidentId ?? null,
  })
  if (replay) {
    return {
      id: replay.id,
      trigger: input.run.mode,
      enqueued: false,
      quotaUsed: replay.quotaUsed,
      quotaLimit: null,
    }
  }

  if (!isBusinessEvalsRunnerEnabled()) {
    throw new BusinessEvalsApiError(503, "RUNNER_PAUSED", "Business eval submissions are temporarily paused by the safety control.")
  }
  const journey = await getJourney(input.agencyId, input.run.journeyId)
  if (journey.template === "legacy_endpoint") {
    throw new BusinessEvalsApiError(
      409,
      "LEGACY_ENDPOINT_RUNNER_REQUIRED",
      "Legacy endpoint journeys continue to run through the deterministic endpoint monitor."
    )
  }
  if (!journey.publishedVersionId) {
    throw new BusinessEvalsApiError(409, "PUBLISHED_VERSION_REQUIRED", "Publish an immutable journey version before running it.")
  }
  if (journey.status === "paused") {
    throw new BusinessEvalsApiError(409, "JOURNEY_PAUSED", "This journey is paused. Resolve the pause before starting another run.")
  }
  const entitlement = await getBusinessEvalsEntitlement(input.agencyId)
  await enforcePublishedJourneyFeatureEntitlement({
    agencyId: input.agencyId,
    journeyId: input.run.journeyId,
    journeyVersionId: journey.publishedVersionId,
    entitlement,
  })
  await assertBusinessEvalsResourceCapacity(input.agencyId, entitlement)
  if (input.run.mode === "verification") {
    await assertVerificationIncident(input.agencyId, input.run.journeyId, input.run.incidentId)
  }

  const markerSeed = crypto.randomUUID()
  let rows: Row[]
  try {
    rows = await supabaseServiceJson<Row[]>("rpc/enqueue_business_eval_run", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: input.agencyId,
        p_workflow_id: input.run.journeyId,
        p_journey_version_id: journey.publishedVersionId,
        p_schedule_id: input.scheduleId ?? null,
        p_trigger_source: input.run.mode,
        p_idempotency_key: input.idempotencyKey,
        p_scheduled_for: input.scheduledFor ?? null,
        p_synthetic_marker: submittedMarkerForRun(markerSeed),
        p_monthly_limit: entitlement.runLimit,
        p_requested_by_user_id: input.userId,
        p_verification_issue_id: input.run.incidentId ?? null,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.toLowerCase().includes("quota")) {
      throw new BusinessEvalsApiError(429, "RUN_QUOTA_REACHED", "The monthly eval-run allowance has been reached. No overage was created.")
    }
    if (message.toLowerCase().includes("rate limit")) {
      throw new BusinessEvalsApiError(429, "RATE_LIMITED", "A business-eval safety rate limit was reached. Wait for the current window to reset before starting another run.")
    }
    if (message.toLowerCase().includes("idempotency key")) {
      throw new BusinessEvalsApiError(409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for this eval-run request.")
    }
    throw error
  }

  const row = rows[0]
  if (!row?.eval_run_id) throw new Error("Supabase did not return the enqueued eval run.")
  return {
    id: String(row.eval_run_id),
    trigger: input.run.mode,
    enqueued: Boolean(row.enqueued),
    quotaUsed: Number(row.quota_used ?? 0),
    quotaLimit: row.quota_limit === null || row.quota_limit === undefined ? entitlement.runLimit : Number(row.quota_limit),
  }
}

export async function findExistingEvalRunReplay(input: {
  agencyId: string
  idempotencyKey: string
  journeyId: string
  journeyVersionId: string | null
  scheduleId: string | null
  trigger: EvalRunInput["mode"] | "scheduled"
  scheduledFor: string | null
  requestedByUserId: string | null
  verificationIssueId: string | null
}): Promise<{ id: string; quotaUsed: number } | null> {
  let rows: Row[]
  try {
    rows = await supabaseServiceJson<Row[]>("rpc/get_business_eval_run_replay", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: input.agencyId,
        p_idempotency_key: input.idempotencyKey,
        p_workflow_id: input.journeyId,
        p_journey_version_id: input.journeyVersionId,
        p_schedule_id: input.scheduleId,
        p_trigger_source: input.trigger,
        p_scheduled_for: input.scheduledFor,
        p_requested_by_user_id: input.requestedByUserId,
        p_verification_issue_id: input.verificationIssueId,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.toLowerCase().includes("idempotency key")) {
      throw new BusinessEvalsApiError(409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for this eval-run request.")
    }
    throw error
  }
  const row = rows[0]
  if (!row?.eval_run_id) return null
  return {
    id: String(row.eval_run_id),
    quotaUsed: Number(row.quota_used ?? 0),
  }
}

export async function attachEvalWorkflowRun(
  agencyId: string,
  evalRunId: string,
  dispatchWorkerId: string,
  orchestrationRunId: string
) {
  const rows = await supabaseServiceJson<Row[]>("rpc/attach_eval_workflow_run", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: agencyId,
      p_eval_run_id: evalRunId,
      p_dispatch_worker_id: dispatchWorkerId,
      p_orchestration_run_id: orchestrationRunId,
    }),
  })
  if (!rows[0]) throw new Error("Supabase did not attach the durable workflow run.")
  return String(rows[0].orchestration_run_id ?? orchestrationRunId)
}

export async function getEvalRunDispatchState(agencyId: string, evalRunId: string) {
  const rows = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${evalRunId}`,
    select: "id,status,dispatch_state,orchestration_run_id",
    limit: "1",
  })}`)
  if (!rows[0]) throw new BusinessEvalsApiError(404, "EVAL_RUN_NOT_FOUND", "Eval run not found.")
  return {
    status: String(rows[0].status),
    dispatchState: String(rows[0].dispatch_state),
    orchestrationRunId: String(rows[0].orchestration_run_id ?? ""),
  }
}

export async function listEvalRuns(input: {
  agencyId: string
  limit: number
  cursor?: string
  journeyId?: string
  status?: string
}) {
  const offsets = decodeCursor(input.cursor)
  const fetchLimit = input.limit + 1
  const filters: Record<string, string> = {
    select: "id,client_id,workflow_id,journey_version_id,trigger_source,status,verdict,started_at,completed_at,duration_ms,summary,business_impact,cleanup_status,created_at",
    agency_id: `eq.${input.agencyId}`,
    order: "created_at.desc,id.desc",
    limit: String(fetchLimit),
    offset: String(offsets.businessEval),
  }
  if (input.journeyId) filters.workflow_id = `eq.${input.journeyId}`
  if (input.status) {
    if (["passed", "degraded", "failed", "inconclusive", "cancelled"].includes(input.status)) {
      filters.verdict = `eq.${input.status}`
    } else {
      filters.status = `eq.${input.status}`
    }
  }

  const legacyStatus = legacyCheckStatus(input.status)
  const legacyFilters: Record<string, string> = {
    select: "id,client_id,workflow_id,check_id,evidence_origin,status,status_code,latency_ms,assertion_results_json,safe_response_summary,error_message,started_at,completed_at,created_at",
    agency_id: `eq.${input.agencyId}`,
    order: "created_at.desc,id.desc",
    limit: String(fetchLimit),
    offset: String(offsets.legacyEndpoint),
  }
  if (input.journeyId) legacyFilters.workflow_id = `eq.${input.journeyId}`
  if (legacyStatus) legacyFilters.status = `eq.${legacyStatus}`

  const [evalRows, legacyRows] = await Promise.all([
    supabaseServiceJson<Row[]>(`eval_runs?${query(filters)}`),
    legacyStatus === false
      ? Promise.resolve([] as Row[])
      : supabaseServiceJson<Row[]>(`check_runs?${query(legacyFilters)}`),
  ])
  const checkNames = await legacyCheckNames(input.agencyId, legacyRows)
  const journeyIds = [...new Set([...evalRows, ...legacyRows].map((row) => String(row.workflow_id ?? "")).filter(Boolean))]
  const journeys = journeyIds.length
    ? await supabaseServiceJson<Row[]>(`workflows?${query({
        select: "id,name",
        agency_id: `eq.${input.agencyId}`,
        id: `in.(${journeyIds.join(",")})`,
      })}`)
    : []
  const journeyNames = new Map(journeys.map((journey) => [String(journey.id), String(journey.name ?? "Historical journey")]))
  const presentedEvalRows = evalRows.map((row) => ({
    ...presentEvalRun(row),
    journeyName: journeyNames.get(String(row.workflow_id)) ?? "Historical journey",
  }))
  const presentedLegacyRows = legacyRows.map((row) => ({
    ...presentLegacyEndpointRun(
    row,
    checkNames.get(String(row.check_id))
    ),
    journeyName: journeyNames.get(String(row.workflow_id)) ?? "Historical journey",
  }))
  const merged = mergeLegacyEndpointHistory(presentedEvalRows, presentedLegacyRows, 0, input.limit)
  const consumedBusinessEval = merged.rows.filter((row) => row.source === "business_eval").length
  const consumedLegacyEndpoint = merged.rows.filter((row) => row.source === "legacy_endpoint").length
  return {
    runs: merged.rows,
    nextCursor: merged.hasMore ? encodeCursor({
      businessEval: offsets.businessEval + consumedBusinessEval,
      legacyEndpoint: offsets.legacyEndpoint + consumedLegacyEndpoint,
    }) : null,
  }
}

export async function getEvalRun(agencyId: string, evalRunId: string) {
  const runs = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    select: "id,client_id,workflow_id,journey_version_id,schedule_id,trigger_source,status,verdict,runner_provider,orchestration_run_id,started_at,completed_at,duration_ms,summary,business_impact,cleanup_status,cleanup_error_summary,cancel_requested_at,created_at,updated_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${evalRunId}`,
    limit: "1",
  })}`)
  if (!runs[0]) return getLegacyEndpointRun(agencyId, evalRunId)
  const [stages, evidence] = await Promise.all([
    supabaseServiceJson<Row[]>(`eval_stage_runs?${query({
      select: "id,stage_definition_id,position,status,verdict,expected_text,observed_text,error_code,diagnostics_json,assertion_results_json,evidence_artifact_ids,started_at,completed_at,duration_ms",
      agency_id: `eq.${agencyId}`,
      eval_run_id: `eq.${evalRunId}`,
      order: "position.asc",
    })}`),
    supabaseServiceJson<Row[]>(`evidence_artifacts?${query({
      select: "id,eval_stage_run_id,artifact_kind,mime_type,byte_size,sha256,redacted,expires_at,created_at",
      agency_id: `eq.${agencyId}`,
      eval_run_id: `eq.${evalRunId}`,
      order: "created_at.asc",
    })}`),
  ])
  return { ...presentEvalRun(runs[0]), stages, evidence }
}

export async function requestEvalRunCancellation(agencyId: string, evalRunId: string, userId: string, idempotencyKey: string) {
  const idempotencyKeyHash = hashCancellationValue(`eval-run-cancellation:${idempotencyKey}`)
  const requestHash = hashCancellationValue(JSON.stringify({
    operation: "eval_run.cancel",
    agencyId,
    evalRunId,
    userId,
  }))
  let rows: Row[]
  try {
    rows = await supabaseServiceJson<Row[]>("rpc/request_business_eval_cancellation", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: agencyId,
        p_eval_run_id: evalRunId,
        p_requested_by_user_id: userId,
        p_idempotency_key_hash: idempotencyKeyHash,
        p_request_hash: requestHash,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("EVAL_RUN_CANCELLATION_IDEMPOTENCY_KEY_REUSED")) {
      throw new BusinessEvalsApiError(409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for this eval-run cancellation.")
    }
    if (message.toLowerCase().includes("not found")) {
      throw new BusinessEvalsApiError(404, "EVAL_RUN_NOT_FOUND", "Eval run not found.")
    }
    if (message.toLowerCase().includes("cannot be cancelled")) {
      throw new BusinessEvalsApiError(409, "EVAL_RUN_NOT_CANCELLABLE", "Only a queued or active eval run can be cancelled.")
    }
    throw error
  }
  if (!rows[0]) throw new BusinessEvalsApiError(409, "EVAL_RUN_NOT_CANCELLABLE", "Only a queued or active eval run can be cancelled.")
  const current = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${evalRunId}`,
    select: "id,orchestration_run_id,cancel_requested_at",
    limit: "1",
  })}`)
  if (!current[0]) throw new BusinessEvalsApiError(404, "EVAL_RUN_NOT_FOUND", "Eval run not found.")
  return {
    id: String(current[0].id),
    cancelRequestedAt: String(current[0].cancel_requested_at ?? rows[0].cancel_requested_at),
    orchestrationRunId: String(current[0].orchestration_run_id ?? ""),
  }
}

function hashCancellationValue(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export async function getEvalEntitlement(agencyId: string) {
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  return { plan: entitlement.planId, runLimit: entitlement.runLimit, evidenceDays: entitlement.evidenceDays }
}

async function assertVerificationIncident(agencyId: string, journeyId: string, incidentId?: string) {
  if (!incidentId) {
    throw new BusinessEvalsApiError(400, "INCIDENT_REQUIRED", "A verification rerun must be linked to an incident.")
  }
  const issues = await supabaseServiceJson<Row[]>(`issues?${query({
    select: "id,status,workflow_id,repair_recorded_at,resolution_note",
    agency_id: `eq.${agencyId}`,
    id: `eq.${incidentId}`,
    workflow_id: `eq.${journeyId}`,
    limit: "1",
  })}`)
  const issue = issues[0]
  if (!issue) throw new BusinessEvalsApiError(404, "INCIDENT_NOT_FOUND", "Incident not found for this journey.")
  if (!issue.repair_recorded_at || !String(issue.resolution_note ?? "").trim()) {
    throw new BusinessEvalsApiError(409, "REPAIR_NOTE_REQUIRED", "Record the repair before requesting its verification rerun.")
  }
}

function presentEvalRun(row: Row) {
  return {
    id: String(row.id),
    projectId: String(row.client_id),
    journeyId: String(row.workflow_id),
    journeyVersionId: String(row.journey_version_id),
    trigger: String(row.trigger_source),
    source: "business_eval" as const,
    status: String(row.status),
    verdict: String(row.verdict),
    runnerProvider: String(row.runner_provider ?? ""),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    summary: String(row.summary ?? ""),
    businessImpact: String(row.business_impact ?? ""),
    cleanupStatus: String(row.cleanup_status ?? "pending"),
    cleanupErrorSummary: String(row.cleanup_error_summary ?? ""),
    cancelRequestedAt: row.cancel_requested_at ? String(row.cancel_requested_at) : null,
    stageEvidenceAvailable: true,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

async function getLegacyEndpointRun(agencyId: string, runId: string) {
  const rows = await supabaseServiceJson<Row[]>(`check_runs?${query({
    select: "id,client_id,workflow_id,check_id,evidence_origin,status,status_code,latency_ms,assertion_results_json,safe_response_summary,error_message,started_at,completed_at,created_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${runId}`,
    limit: "1",
  })}`)
  if (!rows[0]) throw new BusinessEvalsApiError(404, "EVAL_RUN_NOT_FOUND", "Eval run not found.")
  const checkNames = await legacyCheckNames(agencyId, rows)
  return presentLegacyEndpointRun(rows[0], checkNames.get(String(rows[0].check_id)))
}

async function legacyCheckNames(agencyId: string, rows: Row[]) {
  const ids = [...new Set(rows.map((row) => String(row.check_id ?? "")).filter(Boolean))]
  if (!ids.length) return new Map<string, string>()
  const checks = await supabaseServiceJson<Row[]>(`checks?${query({
    select: "id,name",
    agency_id: `eq.${agencyId}`,
    id: `in.(${ids.join(",")})`,
  })}`)
  return new Map(checks.map((row) => [String(row.id), String(row.name ?? "Legacy endpoint check")]))
}

function legacyCheckStatus(status?: string): string | false | undefined {
  if (!status || status === "finalized") return undefined
  if (status === "passed") return "healthy"
  if (status === "degraded" || status === "failed") return status
  if (status === "inconclusive") return "skipped"
  return false
}

function encodeCursor(offsets: { businessEval: number; legacyEndpoint: number }) {
  return Buffer.from(JSON.stringify({ e: offsets.businessEval, l: offsets.legacyEndpoint })).toString("base64url")
}

function decodeCursor(cursor?: string) {
  if (!cursor) return { businessEval: 0, legacyEndpoint: 0 }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { e?: unknown; l?: unknown }
    const businessEval = Number(decoded.e)
    const legacyEndpoint = Number(decoded.l)
    if (Number.isInteger(businessEval) && businessEval >= 0 && Number.isInteger(legacyEndpoint) && legacyEndpoint >= 0) {
      return { businessEval, legacyEndpoint }
    }
  } catch {
    // Invalid and pre-cutover cursors fail closed to the first merged page.
  }
  return { businessEval: 0, legacyEndpoint: 0 }
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
