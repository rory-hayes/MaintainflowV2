import "server-only"

import { start } from "workflow/api"

import { attachEvalWorkflowRun, getEvalRunDispatchState } from "@/lib/api/eval-runs.server"
import { isBusinessEvalsRunnerEnabled } from "@/lib/features/business-evals"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { runBusinessEvalWorkflow } from "@/workflows/eval-run"

export async function dispatchEvalRun(input: { agencyId: string; evalRunId: string }) {
  const workerId = `eval-dispatch:${crypto.randomUUID()}`
  const claims = await supabaseServiceJson<Array<{ eval_run_id: string; agency_id: string }>>("rpc/claim_eval_run_for_dispatch", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_eval_run_id: input.evalRunId,
      p_worker_id: workerId,
      p_lease_seconds: 300,
    }),
  })
  if (!claims[0]) {
    const existing = await getEvalRunDispatchState(input.agencyId, input.evalRunId)
    return {
      orchestrationRunId: existing.orchestrationRunId,
      pending: !existing.orchestrationRunId,
      stoppedBySafetyControl: false,
    }
  }
  return startAndAttach({ agencyId: input.agencyId, evalRunId: input.evalRunId, workerId })
}

export async function recoverPendingEvalRunDispatches(maxBatch = 5) {
  const workerId = `eval-dispatch-recovery:${crypto.randomUUID()}`
  const claims = await supabaseServiceJson<Array<{ eval_run_id: string; agency_id: string }>>("rpc/claim_eval_runs_for_dispatch", {
    method: "POST",
    body: JSON.stringify({
      p_worker_id: workerId,
      p_max_batch: Math.max(1, Math.min(maxBatch, 10)),
      p_lease_seconds: 300,
    }),
  })
  const results = await Promise.all(claims.map(async (claim) => {
    try {
      const attached = await startAndAttach({
        agencyId: String(claim.agency_id),
        evalRunId: String(claim.eval_run_id),
        workerId,
      })
      return {
        evalRunId: String(claim.eval_run_id),
        status: attached.stoppedBySafetyControl ? "runner_paused" as const : "dispatched" as const,
        ...attached,
      }
    } catch (error) {
      return {
        evalRunId: String(claim.eval_run_id),
        status: "failed" as const,
        error: error instanceof Error ? error.message.replaceAll(/https?:\/\/[^\s]+/gi, "[redacted-url]").slice(0, 240) : "Dispatch failed.",
      }
    }
  }))
  return {
    claimed: claims.length,
    dispatched: results.filter((result) => result.status === "dispatched").length,
    runnerPaused: results.filter((result) => result.status === "runner_paused").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  }
}

async function startAndAttach(input: { agencyId: string; evalRunId: string; workerId: string }) {
  let started = false
  try {
    // Enqueue-time checks are insufficient: a queued run can sit between the
    // API and durable dispatch while an operator activates the kill switch.
    // Terminalize only the dispatch lease we own, before starting Workflow.
    const runState = await supabaseServiceJson<Array<{ trigger_source?: string }>>(
      `eval_runs?${new URLSearchParams({
        agency_id: `eq.${input.agencyId}`,
        id: `eq.${input.evalRunId}`,
        select: "trigger_source",
        limit: "1",
      }).toString()}`
    )
    const scheduledExecutionPaused = runState[0]?.trigger_source === "scheduled"
      && ["1", "true", "enabled"].includes(
        process.env.BUSINESS_EVALS_SCHEDULER_KILL_SWITCH?.trim().toLowerCase() ?? ""
      )
    if (!isBusinessEvalsRunnerEnabled() || scheduledExecutionPaused) {
      const stopped = await supabaseServiceJson<Array<{ eval_run_id: string }>>("rpc/cancel_business_eval_run_before_execution", {
        method: "POST",
        body: JSON.stringify({
          p_agency_id: input.agencyId,
          p_eval_run_id: input.evalRunId,
          p_dispatch_worker_id: input.workerId,
          p_reason: "The global business-evals runner safety control was activated before browser execution.",
        }),
      })
      if (!stopped[0]) throw new Error("The paused eval run could not be safely terminalized before dispatch.")
      return { orchestrationRunId: "", pending: false, stoppedBySafetyControl: true }
    }
    const workflowAttemptToken = crypto.randomUUID()
    const run = await start(runBusinessEvalWorkflow, [{
      evalRunId: input.evalRunId,
      workflowAttemptToken,
    }])
    started = true
    const attachedRunId = await attachEvalWorkflowRun(
      input.agencyId,
      input.evalRunId,
      input.workerId,
      run.runId
    )
    return { orchestrationRunId: attachedRunId || run.runId, pending: false, stoppedBySafetyControl: false }
  } catch (error) {
    if (!started) {
      await supabaseServiceJson("rpc/release_eval_run_dispatch_lease", {
        method: "POST",
        body: JSON.stringify({
          p_agency_id: input.agencyId,
          p_eval_run_id: input.evalRunId,
          p_dispatch_worker_id: input.workerId,
        }),
      }).catch(() => undefined)
    }
    throw error
  }
}
