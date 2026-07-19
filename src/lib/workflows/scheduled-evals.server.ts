import "server-only"

import {
  assertBusinessEvalsResourceCapacity,
  enforcePublishedJourneyFeatureEntitlement,
  getBusinessEvalsEntitlement,
} from "@/lib/api/business-evals-entitlements.server"
import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { findExistingEvalRunReplay } from "@/lib/api/eval-runs.server"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { dispatchEvalRun, recoverPendingEvalRunDispatches } from "@/lib/workflows/dispatch-eval-run.server"
import { purgeExpiredEvalEvidence } from "@/lib/workflows/evidence-retention.server"
import { isBusinessEvalsRunnerEnabled } from "@/lib/features/business-evals"
import { submittedMarkerForRun } from "@/lib/email/eval-inbound"

type Row = Record<string, unknown>

type ClaimedSchedule = {
  schedule_id: string
  agency_id: string
  workflow_id: string
  journey_version_id: string
  scheduled_for: string
  lease_expires_at: string
}

type ScheduleResult = {
  scheduleId: string
  status: "dispatched" | "runner_paused" | "already_enqueued" | "quota_blocked" | "entitlement_blocked" | "rate_limited" | "failed"
  evalRunId?: string
  error?: string
}

export async function runScheduledBusinessEvals(input: { batchSize: number; leaseSeconds: number }) {
  const evidenceRetention = await purgeExpiredEvalEvidence(50).catch((error) => ({
    error: error instanceof Error ? safeError(error.message) : "Evidence retention cleanup failed.",
  }))
  const runnerPaused = !isBusinessEvalsRunnerEnabled()
  const schedulerPaused = ["1", "true", "enabled"].includes(
    process.env.BUSINESS_EVALS_SCHEDULER_KILL_SWITCH?.trim().toLowerCase() ?? ""
  )
  if (runnerPaused || schedulerPaused) {
    // Recovery remains active while submissions are paused so already-queued
    // work cannot silently survive the safety window and submit later. The
    // dispatch boundary terminalizes runner-paused work and only permits
    // manual recovery when the scheduler alone is paused.
    const dispatchRecovery = await recoverPendingEvalRunDispatches(5).catch((error) => ({
      error: error instanceof Error ? safeError(error.message) : "Paused dispatch recovery failed.",
    }))
    return {
      paused: true,
      claimed: 0,
      dispatched: 0,
      quotaBlocked: 0,
      failed: 0,
      dispatchRecovery,
      evidenceRetention,
      results: [] as ScheduleResult[],
    }
  }

  const workerId = `eval-scheduler:${crypto.randomUUID()}`
  const claimed = await supabaseServiceJson<ClaimedSchedule[]>("rpc/claim_due_journey_schedules", {
    method: "POST",
    body: JSON.stringify({
      p_worker_id: workerId,
      p_max_batch: Math.max(1, Math.min(input.batchSize, 5)),
      p_lease_seconds: Math.max(120, Math.min(input.leaseSeconds, 900)),
    }),
  })

  const results = await Promise.all(claimed.map((schedule) => enqueueAndDispatchSchedule(schedule)))
  const dispatchRecovery = await recoverPendingEvalRunDispatches(5).catch((error) => ({
    error: error instanceof Error ? safeError(error.message) : "Dispatch recovery failed.",
  }))
  return {
    paused: false,
    claimed: claimed.length,
    dispatched: results.filter((result) => result.status === "dispatched").length,
    alreadyEnqueued: results.filter((result) => result.status === "already_enqueued").length,
    quotaBlocked: results.filter((result) => result.status === "quota_blocked").length,
    entitlementBlocked: results.filter((result) => result.status === "entitlement_blocked").length,
    rateLimited: results.filter((result) => result.status === "rate_limited").length,
    runnerPaused: results.filter((result) => result.status === "runner_paused").length,
    failed: results.filter((result) => result.status === "failed").length,
    dispatchRecovery,
    evidenceRetention,
    results,
  }
}

async function enqueueAndDispatchSchedule(schedule: ClaimedSchedule): Promise<ScheduleResult> {
  try {
    const idempotencyKey = `schedule:${schedule.schedule_id}:${schedule.scheduled_for}`
    const replay = await findExistingEvalRunReplay({
      agencyId: schedule.agency_id,
      idempotencyKey,
      journeyId: schedule.workflow_id,
      journeyVersionId: schedule.journey_version_id,
      scheduleId: schedule.schedule_id,
      trigger: "scheduled",
      scheduledFor: schedule.scheduled_for,
      requestedByUserId: null,
      verificationIssueId: null,
    })
    if (replay) {
      return { scheduleId: schedule.schedule_id, evalRunId: replay.id, status: "already_enqueued" }
    }

    const entitlement = await getBusinessEvalsEntitlement(schedule.agency_id)
    await enforcePublishedJourneyFeatureEntitlement({
      agencyId: schedule.agency_id,
      journeyId: schedule.workflow_id,
      journeyVersionId: schedule.journey_version_id,
      entitlement,
    })
    await assertBusinessEvalsResourceCapacity(schedule.agency_id, entitlement)

    const rows = await supabaseServiceJson<Row[]>("rpc/enqueue_business_eval_run", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: schedule.agency_id,
        p_workflow_id: schedule.workflow_id,
        p_journey_version_id: schedule.journey_version_id,
        p_schedule_id: schedule.schedule_id,
        p_trigger_source: "scheduled",
        p_idempotency_key: idempotencyKey,
        p_scheduled_for: schedule.scheduled_for,
        p_synthetic_marker: submittedMarkerForRun(crypto.randomUUID()),
        p_monthly_limit: entitlement.runLimit,
        p_requested_by_user_id: null,
        p_verification_issue_id: null,
      }),
    })
    const row = rows[0]
    if (!row?.eval_run_id) throw new Error("The scheduler did not receive an eval-run identifier.")
    const evalRunId = String(row.eval_run_id)
    if (!Boolean(row.enqueued)) {
      return { scheduleId: schedule.schedule_id, evalRunId, status: "already_enqueued" }
    }

    const dispatch = await dispatchEvalRun({ agencyId: schedule.agency_id, evalRunId })
    if (dispatch.stoppedBySafetyControl) {
      return { scheduleId: schedule.schedule_id, evalRunId, status: "runner_paused" }
    }
    return { scheduleId: schedule.schedule_id, evalRunId, status: "dispatched" }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled eval enqueue failed."
    const normalized = message.toLowerCase()
    if (normalized.includes("quota")) {
      return { scheduleId: schedule.schedule_id, status: "quota_blocked", error: safeError(message) }
    }
    if (
      (error instanceof BusinessEvalsApiError && error.code === "EMAIL_EVALS_PAID_PLAN_REQUIRED")
      || normalized.includes("active project")
      || normalized.includes("active journey")
    ) {
      return { scheduleId: schedule.schedule_id, status: "entitlement_blocked", error: safeError(message) }
    }
    if (normalized.includes("rate limit") || normalized.includes("rate_limited")) {
      return { scheduleId: schedule.schedule_id, status: "rate_limited", error: safeError(message) }
    }
    return { scheduleId: schedule.schedule_id, status: "failed", error: safeError(message) }
  }
}

function safeError(message: string) {
  return message.replaceAll(/https?:\/\/[^\s]+/gi, "[redacted-url]").slice(0, 240)
}
