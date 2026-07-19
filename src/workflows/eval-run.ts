import { createHash } from "node:crypto"

import { defineHook, FatalError, sleep } from "workflow"
import { z } from "zod"

import type { RestrictedAction } from "@/lib/api/business-evals-contracts"
import { queueFinalizedEvalAlertsStep } from "@/lib/api/alerts-workflow.server"
import { enforceBusinessEvalDestinationRateLimit } from "@/lib/api/business-evals-rate-limit.server"
import { getEvalEntitlement } from "@/lib/api/eval-runs.server"
import { deriveEvalEmailHookToken, recipientHash } from "@/lib/email/eval-inbound"
import { loadResendReceivingHealth } from "@/lib/email/resend-receiving-health.server"
import { decryptVerificationLink } from "@/lib/email/verification-link-crypto"
import { pinnedEndpointFetch } from "@/lib/core/pinned-http.server"
import { isBusinessEvalsRunnerEnabled } from "@/lib/features/business-evals"
import { deletePrivateEvalArtifact, storePrivateEvalArtifact } from "@/lib/runner/evidence-storage.server"
import {
  assertRequiredAssertionResultsAlign,
  createRunnerAssertionResult,
  reclassifyRunnerAssertionResults,
} from "@/lib/runner/assertion-results"
import { getBrowserEvalProvider } from "@/lib/runner/provider.server"
import { assertPublicBrowserTarget } from "@/lib/runner/browser-safety.server"
import { classifyEmailTiming, type EmailTimingResult } from "@/lib/runner/email-timing"
import { createSyntheticRunValues } from "@/lib/runner/synthetic-values"
import {
  createCleanupWebhookEnvelope,
  loadCleanupSigningKey,
  signCleanupWebhook,
} from "@/lib/runner/cleanup-webhook-signing"
import type {
  BrowserEvalStage,
  BrowserPhaseResult,
  BrowserSessionHandle,
  RunnerStageResult,
} from "@/lib/runner/types"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

const evalEmailPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email"),
    inboundEventId: z.string().uuid(),
    receivedAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("cancelled"),
    requestedAt: z.string().datetime(),
  }),
])

export const evalEmailHook = defineHook({ schema: evalEmailPayloadSchema })

type WorkflowStage = BrowserEvalStage & {
  expected: string
  businessImpact: string
}

type EvalWorkflowContext = {
  runId: string
  triggerSource: "manual" | "supervised" | "verification" | "debug" | "scheduled" | "api" | "legacy_backfill"
  agencyId: string
  projectId: string
  journeyId: string
  journeyVersionId: string
  template: "lead_form" | "trial_signup" | "legacy_endpoint"
  startUrl: string
  syntheticMarker: string
  allowedHosts: string[]
  values: Record<string, string>
  stages: WorkflowStage[]
  evidenceDays: number
  emailThresholdSeconds: number | null
  emailMaximumWaitSeconds: number | null
  emailProofMode: "autoresponse" | "forwarded_marker" | null
  emailHookToken: string | null
  emailInboundDomain: string | null
  cancelRequested: boolean
}

type FinalStageResult = RunnerStageResult & {
  evidenceArtifactIds: string[]
}

type ExecutedPhase = {
  session: BrowserSessionHandle
  stages: FinalStageResult[]
  currentUrl: string
  captchaDetected: boolean
  submissionCompletedAt: string | null
}

type EmailHookEvent = Extract<z.infer<typeof evalEmailPayloadSchema>, { kind: "email" }>
type SignedEmailEvent = EmailHookEvent & { verificationLink: string | null }
type EvalEmailOutcome =
  | (SignedEmailEvent & { timing: "on_time" | "late" | "too_late"; latencyMs: number })
  | Extract<z.infer<typeof evalEmailPayloadSchema>, { kind: "cancelled" }>
  | { kind: "timeout" }
  | { kind: "invalid"; reason: string }

export type EvalWorkflowInput = {
  evalRunId: string
  workflowAttemptToken: string
}

export async function runBusinessEvalWorkflow(input: EvalWorkflowInput) {
  "use workflow"

  const workerId = workflowWorkerId(input)
  let context: EvalWorkflowContext
  try {
    context = await prepareEvalRunStep(input.evalRunId, workerId)
  } catch {
    return finalizePreflightFailureStep(input.evalRunId, workerId)
  }
  const orderedStages = [...context.stages].sort((left, right) => left.position - right.position)
  const cleanupStages = orderedStages.filter((stage) => stage.cleanup)
  const businessStages = orderedStages.filter((stage) => !stage.cleanup)
  const emailIndex = businessStages.findIndex((stage) => stage.actions.some((action) => action.type === "wait_for_email"))
  const beforeEmail = emailIndex >= 0 ? businessStages.slice(0, emailIndex) : businessStages
  const emailStage = emailIndex >= 0 ? businessStages[emailIndex] : null
  const afterEmail = emailIndex >= 0 ? businessStages.slice(emailIndex + 1) : []
  let session: BrowserSessionHandle | undefined
  let results: FinalStageResult[] = []
  let submissionCompletedAt: string | null = null

  try {
    try {
      if (context.cancelRequested) {
        results.push(...businessStages.map((stage) => cancelledStage(stage, "The run was cancelled before browser execution.")))
      } else if (beforeEmail.length) {
        const phase = await executeBrowserPhaseStep(context, beforeEmail, undefined, workerId)
        session = phase.session
        submissionCompletedAt = phase.submissionCompletedAt
        results.push(...phase.stages)
      }

      const terminalBeforeEmail = hasTerminalResult(results)
      if (emailStage && !terminalBeforeEmail && !context.cancelRequested) {
        if (!context.emailHookToken || !context.emailThresholdSeconds || !context.emailMaximumWaitSeconds) {
          results.push(inconclusiveStage(emailStage, "EMAIL_PROOF_NOT_CONFIGURED", "The inbound email channel is not configured for this run."))
        } else if (!submissionCompletedAt) {
          results.push(inconclusiveStage(emailStage, "SUBMISSION_TIME_MISSING", "The runner could not prove the persisted submission completion time, so email timing was not inferred."))
        } else {
          const hook = evalEmailHook.create({ token: context.emailHookToken })
          const existingEmail = await findInboundEmailStep(context.runId)
          let emailOutcome: EvalEmailOutcome
          if (existingEmail) {
            hook.dispose()
            emailOutcome = emailOutcomeFromTiming(existingEmail, await classifyEmailTimingStep({
              submissionCompletedAt,
              thresholdSeconds: context.emailThresholdSeconds,
              maximumWaitSeconds: context.emailMaximumWaitSeconds,
              receivedAt: existingEmail.receivedAt,
            }))
          } else {
            const wait = await classifyEmailTimingStep({
              submissionCompletedAt,
              thresholdSeconds: context.emailThresholdSeconds,
              maximumWaitSeconds: context.emailMaximumWaitSeconds,
            })
            if (wait.status === "pending") {
              const hookOutcome = await Promise.race([
                hook,
                sleep(wait.remainingMs).then(() => ({ kind: "timeout" as const })),
              ])
              const finalPersistedEmail: SignedEmailEvent | null = hookOutcome.kind === "timeout"
                ? await findInboundEmailStep(context.runId)
                : hookOutcome.kind === "email"
                  ? await findInboundEmailStep(context.runId, hookOutcome.inboundEventId)
                  : null
              const effectiveEmail = finalPersistedEmail
              emailOutcome = effectiveEmail
                ? emailOutcomeFromTiming(effectiveEmail, await classifyEmailTimingStep({
                    submissionCompletedAt,
                    thresholdSeconds: context.emailThresholdSeconds,
                    maximumWaitSeconds: context.emailMaximumWaitSeconds,
                    receivedAt: effectiveEmail.receivedAt,
                  }))
                : hookOutcome.kind === "cancelled"
                  ? hookOutcome
                  : { kind: "timeout" }
            } else if (wait.status === "timeout") {
              emailOutcome = { kind: "timeout" }
            } else if (wait.status === "invalid") {
              emailOutcome = { kind: "invalid", reason: wait.reason }
            } else {
              emailOutcome = { kind: "timeout" }
            }
            hook.dispose()
          }
          if (emailOutcome.kind === "cancelled") {
            results.push(cancelledStage(emailStage, "The run was cancelled while waiting for email evidence."))
          } else if (emailOutcome.kind === "timeout") {
            const receivingHealth = context.emailInboundDomain
              ? await receivingHealthStep({
                  inboundDomain: context.emailInboundDomain,
                  submissionCompletedAt,
                  maximumWaitSeconds: context.emailMaximumWaitSeconds,
                })
              : { status: "unknown" as const, reason: "The inbound email domain was not durably configured for this run." }
            results.push(receivingHealth.status === "healthy"
              ? timedEmailFailureStage(
                  emailStage,
                  submissionCompletedAt,
                  null,
                  "EMAIL_TIMEOUT",
                  `The configured email proof did not arrive within the ${context.emailMaximumWaitSeconds}-second final wait while the signed Resend receiving pipeline was independently observed as healthy.`
                )
              : inconclusiveStage(
                  emailStage,
                  "EMAIL_RECEIVING_HEALTH_UNKNOWN",
                  `The configured email proof was not observed, but its absence is not a trustworthy failure because receiving-pipeline health was unavailable: ${receivingHealth.reason}`
                ))
          } else if (emailOutcome.kind === "invalid") {
            results.push(inconclusiveStage(emailStage, "EMAIL_TIMING_INVALID", emailOutcome.reason))
          } else if (emailOutcome.timing === "too_late") {
            results.push(timedEmailFailureStage(
              emailStage,
              submissionCompletedAt,
              emailOutcome.receivedAt,
              "EMAIL_MAXIMUM_WAIT_EXCEEDED",
              `The ${emailProofLabel(context.emailProofMode)} arrived in ${formatDuration(emailOutcome.latencyMs)}, beyond the ${context.emailMaximumWaitSeconds}-second final wait.`
            ))
          } else {
            results.push(emailOutcome.timing === "late"
              ? degradedEmailStage(
                  emailStage,
                  submissionCompletedAt,
                  emailOutcome.receivedAt,
                  `The ${emailProofLabel(context.emailProofMode)} arrived in ${formatDuration(emailOutcome.latencyMs)}, beyond the ${context.emailThresholdSeconds}-second threshold.`
                )
              : passedEmailStage(emailStage, submissionCompletedAt, emailOutcome.receivedAt, emailOutcome.latencyMs, context.emailProofMode))
            if (afterEmail.length) {
              if (!emailOutcome.verificationLink && afterEmail.some(hasEmailLinkAction)) {
                results.push(...afterEmail.map((stage) => inconclusiveStage(stage, "VERIFICATION_LINK_MISSING", "The verified email did not contain an allowlisted verification link.")))
              } else {
                const postEmailStages = afterEmail.map((stage) => withVerificationLink(stage, emailOutcome.verificationLink))
                const phase = await executeBrowserPhaseStep(context, postEmailStages, session, workerId, true)
                session = phase.session
                results.push(...phase.stages)
              }
            }
          }
        }
      } else if (emailStage) {
        results.push(notRunStage(emailStage, "An earlier stage prevented the email assertion from running."))
      }
    } catch (error) {
      const firstUnreached = businessStages.find((stage) => !results.some((result) => result.stageId === stage.id))
      if (firstUnreached) {
        results.push(inconclusiveStage(
          firstUnreached,
          "WORKFLOW_STEP_FAILED",
          `The durable runner could not produce trustworthy evidence: ${safeError(error)}`
        ))
      }
    }

    for (const stage of businessStages) {
      if (!results.some((result) => result.stageId === stage.id)) {
        results.push(notRunStage(stage, "An earlier required stage did not complete."))
      }
    }

    const cancellation = await cancellationRequestedStep(context.runId)
    if (cancellation && !results.some((result) => result.verdict === "failed" || result.verdict === "inconclusive")) {
      results = results.map((result) => result.verdict === "not_run"
        ? result
        : {
            ...result,
            verdict: "cancelled" as const,
            errorCode: "CANCELLED",
            assertionResults: reclassifyRunnerAssertionResults(result.assertionResults, "cancelled"),
          })
    }

    const cleanup = await executeCleanupStep(context, cleanupStages, session, workerId)
    session = cleanup.session ?? session
    results.push(...cleanup.results)

    const normalized = normalizeStageResults(orderedStages, results)
    const final = await finalizeEvalRunStep(context, workerId, normalized)
    // Finalization is already committed before this durable, idempotent step.
    // Alert-provider or queue transients can retry without changing the verdict.
    await queueFinalizedEvalAlertsStep({
      agencyId: context.agencyId,
      evalRunId: context.runId,
      incidentId: final.incidentId,
    })
    return { evalRunId: context.runId, ...final }
  } finally {
    if (session) await releaseBrowserSessionStep(session)
  }
}

async function prepareEvalRunStep(evalRunId: string, workerId: string): Promise<EvalWorkflowContext> {
  "use step"

  const claimed = await supabaseServiceJson<Row[]>("rpc/claim_business_eval_run", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: evalRunId,
      p_worker_id: workerId,
      p_lease_seconds: 7_200,
    }),
  })
  if (!claimed[0]) throw new Error("The eval run could not be claimed by its durable worker.")

  const runs = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    select: "id,agency_id,client_id,workflow_id,journey_version_id,trigger_source,synthetic_marker,cancel_requested_at",
    id: `eq.${evalRunId}`,
    limit: "1",
  })}`)
  const run = runs[0]
  if (!run) throw new Error("Eval run not found after claim.")
  const agencyId = String(run.agency_id)
  const journeyVersionId = String(run.journey_version_id)
  const versions = await supabaseServiceJson<Row[]>(`journey_versions?${query({
    select: "id,template,start_url,authorization_id",
    id: `eq.${journeyVersionId}`,
    agency_id: `eq.${agencyId}`,
    limit: "1",
  })}`)
  const version = versions[0]
  if (!version) throw new Error("The immutable journey version was not found.")
  const stageRows = await supabaseServiceJson<Row[]>(`journey_stage_definitions?${query({
    select: "id,stage_key,name,position,action_manifest_json,expected_text,business_impact,timing_threshold_ms,is_cleanup",
    journey_version_id: `eq.${journeyVersionId}`,
    agency_id: `eq.${agencyId}`,
    order: "position.asc",
  })}`)
  if (!stageRows.length) throw new Error("The immutable journey version contains no stages.")

  const authorizationId = String(version.authorization_id ?? "")
  const authorization = authorizationId
    ? (await supabaseServiceJson<Row[]>(`project_authorizations?${query({
        select: "hostname,approved_action_domains,revoked_at",
        id: `eq.${authorizationId}`,
        agency_id: `eq.${agencyId}`,
        revoked_at: "is.null",
        limit: "1",
      })}`))[0]
    : null
  if (String(version.template) !== "legacy_endpoint" && !authorization) {
    throw new Error("The project owner attestation is missing or revoked.")
  }

  const stages = stageRows.map(stageFromRow)
  const startHost = new URL(String(version.start_url)).hostname.toLowerCase()
  const actionDomains = Array.isArray(authorization?.approved_action_domains)
    ? authorization.approved_action_domains.map(String)
    : []
  const allowedHosts = [...new Set([startHost, String(authorization?.hostname ?? ""), ...actionDomains].map(normalizeHost).filter(Boolean))]
  const emailAction = stages.flatMap((stage) => stage.actions).find((action) => action.type === "wait_for_email")
  const emailThresholdSeconds = emailAction?.type === "wait_for_email" ? emailAction.thresholdSeconds : null
  const emailMaximumWaitSeconds = emailAction?.type === "wait_for_email" ? emailAction.maximumWaitSeconds : null
  const emailProofMode = emailAction?.type === "wait_for_email"
    ? emailAction.proofMode === "forwarded_marker" ? "forwarded_marker" : "autoresponse"
    : null
  const routingSecret = emailThresholdSeconds ? requireSecret("EVAL_EMAIL_ROUTING_SECRET") : undefined
  const inboundDomain = emailThresholdSeconds
    ? requireEnv("EVAL_INBOUND_DOMAIN")
    : process.env.EVAL_SYNTHETIC_EMAIL_DOMAIN?.trim()
      || process.env.EVAL_INBOUND_DOMAIN?.trim()
      || "example.invalid"
  const syntheticMarker = String(run.synthetic_marker)
  const values = createSyntheticRunValues({
    runId: evalRunId,
    syntheticMarker,
    inboundDomain,
    routingSecret,
  })
  const emailHookToken = emailThresholdSeconds && routingSecret ? deriveEvalEmailHookToken(evalRunId, routingSecret) : null
  const entitlement = await getEvalEntitlement(agencyId)

  await supabaseServiceJson(`eval_runs?${query({ id: `eq.${evalRunId}`, agency_id: `eq.${agencyId}` })}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      status: "running",
      recipient_hash: recipientHash(values.email),
      updated_at: new Date().toISOString(),
    }),
  })

  return {
    runId: evalRunId,
    triggerSource: String(run.trigger_source) as EvalWorkflowContext["triggerSource"],
    agencyId,
    projectId: String(run.client_id),
    journeyId: String(run.workflow_id),
    journeyVersionId,
    template: String(version.template) as EvalWorkflowContext["template"],
    startUrl: String(version.start_url),
    syntheticMarker,
    allowedHosts,
    values,
    stages,
    evidenceDays: entitlement.evidenceDays,
    emailThresholdSeconds,
    emailMaximumWaitSeconds,
    emailProofMode,
    emailHookToken,
    emailInboundDomain: emailThresholdSeconds ? inboundDomain : null,
    cancelRequested: Boolean(run.cancel_requested_at),
  }
}

async function finalizePreflightFailureStep(evalRunId: string, workerId: string) {
  "use step"

  const runs = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    select: "id,agency_id,workflow_id,journey_version_id,status,worker_id",
    id: `eq.${evalRunId}`,
    limit: "1",
  })}`)
  const run = runs[0]
  if (!run || String(run.worker_id ?? "") !== workerId || !["claimed", "running"].includes(String(run.status))) {
    // A duplicate workflow attempt that never acquired the run must never
    // terminalize work owned by another unique attempt.
    return { evalRunId, verdict: "not_run", incidentId: null, schedulePaused: false, preflightFinalized: false }
  }

  const stages = await supabaseServiceJson<Row[]>(`journey_stage_definitions?${query({
    select: "id,stage_key,position,is_cleanup,expected_text,business_impact",
    agency_id: `eq.${String(run.agency_id)}`,
    journey_version_id: `eq.${String(run.journey_version_id)}`,
    order: "position.asc",
  })}`)
  if (!stages.length) {
    throw new FatalError("The claimed eval run has no immutable stages and requires operator repair.")
  }

  const firstBusinessStage = stages.find((stage) => !Boolean(stage.is_cleanup)) ?? stages[0]
  const at = new Date().toISOString()
  const stageResults = stages.map((stage) => {
    const isProblem = stage.id === firstBusinessStage.id
    const verdict = isProblem ? "inconclusive" as const : "not_run" as const
    const observedText = isProblem
      ? "The runner preflight could not establish a trustworthy execution context. No customer-visible browser action was replayed."
      : "The stage did not run because preflight did not complete."
    return {
      stageId: String(stage.id),
      verdict,
      observedText,
      errorCode: isProblem ? "RUNNER_PREFLIGHT_FAILED" : "",
      diagnostics: {},
      assertionResults: [createRunnerAssertionResult({
        assertionId: `stage:${String(stage.id)}`,
        required: true,
        expectedRule: String(stage.expected_text ?? stage.stage_key ?? "Complete the published stage."),
        safeObservation: observedText,
        result: verdict,
        evaluatedAt: at,
      })],
      evidenceArtifactIds: [],
      startedAt: at,
      completedAt: at,
      durationMs: 0,
    }
  })
  for (const result of stageResults) {
    assertRequiredAssertionResultsAlign(result.verdict, result.assertionResults)
  }
  const hasCleanup = stages.some((stage) => Boolean(stage.is_cleanup))
  const fingerprint = createHash("sha256")
    .update(`${String(run.workflow_id)}:${String(firstBusinessStage.stage_key)}:RUNNER_PREFLIGHT_FAILED`)
    .digest("hex")
  const finalized = await supabaseServiceJson<Row[]>("rpc/finalize_business_eval_run", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: evalRunId,
      p_worker_id: workerId,
      p_stage_results: stageResults,
      p_summary: "The eval run stopped during runner preflight before a trustworthy customer-visible execution could begin.",
      p_business_impact: String(firstBusinessStage.business_impact ?? ""),
      p_failure_fingerprint: fingerprint,
      p_cleanup_status: hasCleanup ? "failed" : "not_required",
      p_cleanup_error_summary: hasCleanup ? "Cleanup was not required because browser execution did not begin, but it could not be independently proven." : "",
      p_completed_at: at,
    }),
  })
  const row = finalized[0]
  if (!row) throw new Error("Supabase did not finalize the preflight failure.")
  return {
    evalRunId,
    verdict: String(row.final_verdict),
    incidentId: row.incident_id ? String(row.incident_id) : null,
    schedulePaused: Boolean(row.schedule_paused),
    preflightFinalized: true,
  }
}

async function executeBrowserPhaseStep(
  context: EvalWorkflowContext,
  stages: WorkflowStage[],
  session: BrowserSessionHandle | undefined,
  workerId: string,
  forceUnsafeSideEffect = false
): Promise<ExecutedPhase> {
  "use step"

  const sideEffectPhaseKey = unsafeSideEffectPhaseKey(stages, forceUnsafeSideEffect)
  if (sideEffectPhaseKey) {
    assertRunnerExecutionAllowed(context.triggerSource)
    const attempts = await supabaseServiceJson<Row[]>("rpc/begin_eval_run_side_effect_phase", {
      method: "POST",
      body: JSON.stringify({
        p_eval_run_id: context.runId,
        p_phase_key: sideEffectPhaseKey,
        p_worker_id: workerId,
      }),
    })
    if (!attempts[0]?.may_execute) {
      throw new FatalError(
        "A prior browser attempt may already have produced a customer-visible side effect. The phase was not retried and the run is inconclusive."
      )
    }
  }

  try {
    const provider = getBrowserEvalProvider()
    const phase = await provider.executePhase({
      session,
      runId: context.runId,
      traceMode: "diagnostic",
      startUrl: context.startUrl,
      allowedHosts: context.allowedHosts,
      stages,
      values: context.values,
      assertExecutionAllowed: async () => assertRunnerExecutionAllowed(context.triggerSource),
      consumeDestination: async (url) => enforceBusinessEvalDestinationRateLimit(url.hostname),
    })
    let persistedSideEffectCompletedAt: string | null = null
    if (sideEffectPhaseKey) {
      const completedAt = phase.sideEffectCompletedAt ?? new Date().toISOString()
      const completed = await supabaseServiceJson<Row[]>("rpc/complete_eval_run_side_effect_phase_at", {
        method: "POST",
        body: JSON.stringify({
          p_eval_run_id: context.runId,
          p_phase_key: sideEffectPhaseKey,
          p_worker_id: workerId,
          p_completed_at: completedAt,
        }),
      })
      persistedSideEffectCompletedAt = completed[0]?.completed_at
        ? new Date(String(completed[0].completed_at)).toISOString()
        : null
      if (!persistedSideEffectCompletedAt) {
        throw new Error("The browser side-effect completion time was not durably persisted.")
      }
    }
    const evidenceByStage = await persistPhaseArtifacts(context, phase)
    await supabaseServiceJson(`eval_runs?${query({ id: `eq.${context.runId}`, agency_id: `eq.${context.agencyId}` })}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({
        runner_provider: provider.name,
        runner_session_json: safeSessionSummary(phase.session, phase.currentUrl),
        updated_at: new Date().toISOString(),
      }),
    })
    return {
      session: phase.session,
      currentUrl: phase.currentUrl,
      captchaDetected: phase.captchaDetected,
      submissionCompletedAt: persistedSideEffectCompletedAt,
      stages: phase.stages.map((stage) => ({
        ...stage,
        evidenceArtifactIds: evidenceByStage.get(stage.stageId) ?? [],
      })),
    }
  } catch (error) {
    if (sideEffectPhaseKey) {
      throw new FatalError(
        `A customer-visible browser phase stopped after its one permitted attempt. It was not retried: ${safeError(error)}`
      )
    }
    throw error
  }
}

function unsafeSideEffectPhaseKey(stages: WorkflowStage[], forceUnsafeSideEffect = false) {
  const hasUnsafeAction = forceUnsafeSideEffect || stages.some((stage) => stage.actions.some((action) =>
    action.type === "click"
    || action.type === "open_email_link"
    || (action.type === "cleanup" && action.mode === "in_product")
  ))
  if (!hasUnsafeAction) return null
  const identity = stages.map((stage) => ({
    stageId: stage.id,
    position: stage.position,
    actions: stage.actions.map((action) => ({ id: action.id, type: action.type })),
  }))
  return `browser:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
}

async function executeCleanupStep(
  context: EvalWorkflowContext,
  stages: WorkflowStage[],
  session: BrowserSessionHandle | undefined,
  workerId: string
): Promise<{ session?: BrowserSessionHandle; results: FinalStageResult[] }> {
  "use step"

  if (!stages.length) return { session, results: [] }
  const results: FinalStageResult[] = []
  let activeSession = session
  for (const stage of stages) {
    const webhookActions = stage.actions.filter((action) => action.type === "cleanup" && action.mode === "webhook")
    if (webhookActions.length) {
      const started = Date.now()
      try {
        for (const action of webhookActions) {
          if (action.type !== "cleanup" || !action.webhookUrl) throw new Error("The cleanup webhook URL is missing.")
          await callCleanupWebhook(context, action.webhookUrl)
        }
        results.push(passedStage(stage, started, "The idempotent customer-owned cleanup webhook completed."))
      } catch (error) {
        results.push(failedStage(stage, "CLEANUP_WEBHOOK_FAILED", safeError(error), started))
      }
      continue
    }

    try {
      assertRunnerExecutionAllowed(context.triggerSource)
      const sideEffectPhaseKey = unsafeSideEffectPhaseKey([stage])
      if (!sideEffectPhaseKey) throw new Error("In-product cleanup requires a persisted side-effect phase key.")
      const attempts = await supabaseServiceJson<Row[]>("rpc/begin_eval_run_side_effect_phase", {
        method: "POST",
        body: JSON.stringify({
          p_eval_run_id: context.runId,
          p_phase_key: sideEffectPhaseKey,
          p_worker_id: workerId,
        }),
      })
      if (!attempts[0]?.may_execute) {
        throw new Error("A prior cleanup attempt may already have deleted the synthetic account; cleanup was not clicked again.")
      }
      const provider = getBrowserEvalProvider()
      const phase = await provider.executePhase({
        session: activeSession,
        runId: context.runId,
        traceMode: "diagnostic",
        startUrl: context.startUrl,
        allowedHosts: context.allowedHosts,
        stages: [stage],
        values: context.values,
        assertExecutionAllowed: async () => assertRunnerExecutionAllowed(context.triggerSource),
        consumeDestination: async (url) => enforceBusinessEvalDestinationRateLimit(url.hostname),
      })
      activeSession = phase.session
      const evidenceByStage = await persistPhaseArtifacts(context, phase)
      await supabaseServiceJson<Row[]>("rpc/complete_eval_run_side_effect_phase", {
        method: "POST",
        body: JSON.stringify({
          p_eval_run_id: context.runId,
          p_phase_key: sideEffectPhaseKey,
          p_worker_id: workerId,
        }),
      })
      results.push(...phase.stages.map((result) => ({
        ...result,
        evidenceArtifactIds: evidenceByStage.get(result.stageId) ?? [],
      })))
    } catch (error) {
      results.push(failedStage(stage, "CLEANUP_RUNNER_FAILED", safeError(error)))
    }
  }
  return { session: activeSession, results }
}

async function cancellationRequestedStep(runId: string) {
  "use step"
  const rows = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    select: "cancel_requested_at",
    id: `eq.${runId}`,
    limit: "1",
  })}`)
  return Boolean(rows[0]?.cancel_requested_at)
}

async function findInboundEmailStep(runId: string, inboundEventId?: string): Promise<SignedEmailEvent | null> {
  "use step"
  const rows = await supabaseServiceJson<Row[]>(`inbound_email_events?${query({
    select: "id,agency_id,received_at,payload_summary_json",
    eval_run_id: `eq.${runId}`,
    ...(inboundEventId ? { id: `eq.${inboundEventId}` } : {}),
    provider: "eq.resend",
    order: "received_at.asc",
    limit: "1",
  })}`)
  const row = rows[0]
  if (!row) return null
  const summary = row.payload_summary_json as Row | undefined
  const verificationLink = typeof summary?.verificationLinkCiphertext === "string"
    ? decryptVerificationLink(
        summary.verificationLinkCiphertext,
        requireEmailLinkEncryptionKey(),
        { agencyId: String(row.agency_id), runId, eventId: String(row.id) }
      )
    : null
  return {
    kind: "email",
    inboundEventId: String(row.id),
    receivedAt: new Date(String(row.received_at)).toISOString(),
    verificationLink,
  }
}

async function classifyEmailTimingStep(input: {
  submissionCompletedAt: string
  thresholdSeconds: number
  maximumWaitSeconds: number
  receivedAt?: string | null
}): Promise<EmailTimingResult> {
  "use step"
  return classifyEmailTiming({ ...input, nowMs: Date.now() })
}

async function receivingHealthStep(input: {
  inboundDomain: string
  submissionCompletedAt: string
  maximumWaitSeconds: number
}) {
  "use step"
  try {
    return await loadResendReceivingHealth(input)
  } catch {
    return {
      status: "unknown" as const,
      reason: "The server-side Resend receiving-health signal could not be read.",
    }
  }
}

async function finalizeEvalRunStep(
  context: EvalWorkflowContext,
  workerId: string,
  results: FinalStageResult[]
) {
  "use step"

  for (const result of results) {
    assertRequiredAssertionResultsAlign(result.verdict, result.assertionResults)
  }

  const cleanupResults = results.filter((result) => context.stages.find((stage) => stage.id === result.stageId)?.cleanup)
  const cleanupStatus = cleanupResults.length === 0
    ? "not_required"
    : cleanupResults.every((result) => result.verdict === "passed" || result.verdict === "degraded")
      ? "passed"
      : "failed"
  const firstProblem = results.find((result) => ["failed", "inconclusive"].includes(result.verdict))
  const summary = firstProblem
    ? firstProblem.observed
    : results.some((result) => result.verdict === "cancelled")
      ? "The eval run was cancelled and required cleanup was still attempted."
      : "Every enabled deterministic business assertion completed."
  const impact = firstProblem
    ? context.stages.find((stage) => stage.id === firstProblem.stageId)?.businessImpact ?? ""
    : ""
  const firstProblemStage = firstProblem
    ? context.stages.find((stage) => stage.id === firstProblem.stageId)
    : undefined
  const fingerprint = firstProblem
    ? createHash("sha256").update(`${context.journeyId}:${firstProblemStage?.key ?? "unknown_stage"}:${firstProblem.errorCode ?? firstProblem.verdict}`).digest("hex")
    : ""
  const rows = await supabaseServiceJson<Row[]>("rpc/finalize_business_eval_run", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: context.runId,
      p_worker_id: workerId,
      p_stage_results: results.map((result) => ({
        stageId: result.stageId,
        verdict: result.verdict,
        observedText: result.observed,
        errorCode: result.errorCode ?? "",
        diagnostics: result.diagnostics,
        assertionResults: result.assertionResults,
        evidenceArtifactIds: result.evidenceArtifactIds,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      })),
      p_summary: summary,
      p_business_impact: impact,
      p_failure_fingerprint: fingerprint,
      p_cleanup_status: cleanupStatus,
      p_cleanup_error_summary: cleanupStatus === "failed" ? cleanupResults.find((result) => result.verdict === "failed")?.observed ?? "Cleanup did not complete." : "",
      p_completed_at: new Date().toISOString(),
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Supabase did not finalize the eval run.")
  return {
    verdict: String(row.final_verdict),
    incidentId: row.incident_id ? String(row.incident_id) : null,
    schedulePaused: Boolean(row.schedule_paused),
  }
}

async function releaseBrowserSessionStep(session: BrowserSessionHandle) {
  "use step"
  await getBrowserEvalProvider().releaseSession(session)
}

async function persistPhaseArtifacts(context: EvalWorkflowContext, phase: BrowserPhaseResult) {
  const idsByStage = new Map<string, string[]>()
  for (const artifact of phase.artifacts) {
    const artifactId = crypto.randomUUID()
    const stored = await storePrivateEvalArtifact({
      agencyId: context.agencyId,
      projectId: context.projectId,
      journeyId: context.journeyId,
      runId: context.runId,
      artifact,
      artifactId,
    })
    const expiresAt = new Date(Date.now() + context.evidenceDays * 86_400_000).toISOString()
    try {
      await supabaseServiceJson("evidence_artifacts", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify({
          id: artifactId,
          agency_id: context.agencyId,
          eval_run_id: context.runId,
          artifact_kind: databaseArtifactKind(stored.kind),
          storage_bucket: "maintainflow-eval-evidence",
          storage_path: stored.storagePath,
          mime_type: stored.contentType,
          byte_size: stored.byteSize,
          sha256: stored.sha256,
          redacted: stored.redacted,
          report_safe: stored.reportSafe,
          synthetic_marker: context.syntheticMarker,
          expires_at: expiresAt,
        }),
      })
    } catch (metadataError) {
      try {
        await deletePrivateEvalArtifact(stored.storagePath)
      } catch (cleanupError) {
        throw new AggregateError(
          [metadataError, cleanupError],
          "Eval evidence metadata failed and the uploaded object could not be removed."
        )
      }
      throw metadataError
    }
    idsByStage.set(artifact.stageId, [...(idsByStage.get(artifact.stageId) ?? []), artifactId])
  }
  return idsByStage
}

function requireEmailLinkEncryptionKey() {
  const value = process.env.EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64?.trim() ?? ""
  if (!value) throw new Error("EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64 is not configured.")
  return value
}

async function callCleanupWebhook(context: EvalWorkflowContext, target: string) {
  assertRunnerExecutionAllowed(context.triggerSource)
  // This shares the exact public-address, HTTPS, attestation and global-domain
  // denylist boundary used by browser form actions and verification links.
  const safety = await assertPublicBrowserTarget(target, context.allowedHosts)
  await enforceBusinessEvalDestinationRateLimit(safety.url.hostname)
  const signingKey = loadCleanupSigningKey()
  const timestamp = Math.floor(Date.now() / 1_000)
  const envelope = createCleanupWebhookEnvelope({
    runId: context.runId,
    journeyId: context.journeyId,
    syntheticMarker: context.syntheticMarker,
    target: safety.url,
    issuedAt: timestamp,
  })
  const payload = JSON.stringify(envelope)
  const signature = signCleanupWebhook(payload, envelope.issuedAt, signingKey)
  const response = await pinnedEndpointFetch(safety.url, safety.addresses, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": envelope.eventId,
      "X-MaintainFlow-Key-Id": signingKey.keyId,
      "X-MaintainFlow-Timestamp": String(envelope.issuedAt),
      "X-MaintainFlow-Signature": `ed25519=${signature}`,
    },
    body: payload,
  })
  if (!response.ok) throw new Error(`The cleanup webhook returned HTTP ${response.status}.`)
}

function assertRunnerExecutionAllowed(triggerSource: EvalWorkflowContext["triggerSource"]) {
  const scheduledExecutionPaused = triggerSource === "scheduled"
    && ["1", "true", "enabled"].includes(
      process.env.BUSINESS_EVALS_SCHEDULER_KILL_SWITCH?.trim().toLowerCase() ?? ""
    )
  if (!isBusinessEvalsRunnerEnabled() || scheduledExecutionPaused) {
    throw new Error("RUNNER_PAUSED: the global business-evals execution safety control is active.")
  }
}

function stageFromRow(row: Row): WorkflowStage {
  const manifest = row.action_manifest_json
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("A journey stage contains an invalid restricted action manifest.")
  }
  const record = manifest as Row
  if (!Array.isArray(record.actions)) throw new Error("A journey stage action manifest must contain an actions array.")
  return {
    id: String(row.id),
    key: String(row.stage_key),
    name: String(row.name),
    position: Number(row.position),
    required: record.required !== false,
    cleanup: Boolean(row.is_cleanup),
    expected: String(row.expected_text ?? row.name),
    businessImpact: String(row.business_impact ?? ""),
    timingThresholdMs: row.timing_threshold_ms === null || row.timing_threshold_ms === undefined ? null : Number(row.timing_threshold_ms),
    actions: record.actions as RestrictedAction[],
  }
}

function withVerificationLink(stage: WorkflowStage, verificationLink: string | null): WorkflowStage {
  if (!verificationLink) return stage
  return {
    ...stage,
    actions: stage.actions.map((action) => action.type === "open_email_link"
      ? {
          id: action.id,
          label: action.label,
          timeoutMs: action.timeoutMs,
          type: "navigate" as const,
          url: verificationLink,
        }
      : action),
  }
}

function hasEmailLinkAction(stage: WorkflowStage) {
  return stage.actions.some((action) => action.type === "open_email_link")
}

function normalizeStageResults(stages: WorkflowStage[], results: FinalStageResult[]) {
  return stages
    .sort((left, right) => left.position - right.position)
    .map((stage) => results.find((result) => result.stageId === stage.id) ?? notRunStage(stage, "The stage was not reached."))
}

function hasTerminalResult(results: FinalStageResult[]) {
  return results.some((result) => ["failed", "inconclusive", "cancelled"].includes(result.verdict))
}

function passedEmailStage(
  stage: WorkflowStage,
  submissionCompletedAt: string,
  receivedAt: string,
  latencyMs: number,
  proofMode: EvalWorkflowContext["emailProofMode"]
): FinalStageResult {
  return baseResult(
    stage,
    "passed",
    new Date(submissionCompletedAt).toISOString(),
    new Date(receivedAt).toISOString(),
    proofMode === "forwarded_marker"
      ? `A signed inbound event matched the authenticated journey alias and exact run marker ${formatDuration(latencyMs)} after the persisted submission completion.`
      : `A signed inbound event matched the unique run recipient ${formatDuration(latencyMs)} after the persisted submission completion.`,
    null
  )
}

function emailProofLabel(mode: EvalWorkflowContext["emailProofMode"]) {
  return mode === "forwarded_marker" ? "marked forwarded notification" : "run-specific autoresponse"
}

function degradedEmailStage(stage: WorkflowStage, submissionCompletedAt: string, receivedAt: string, observed: string): FinalStageResult {
  return baseResult(
    stage,
    "degraded",
    new Date(submissionCompletedAt).toISOString(),
    new Date(receivedAt).toISOString(),
    observed,
    "EMAIL_THRESHOLD_EXCEEDED"
  )
}

function timedEmailFailureStage(
  stage: WorkflowStage,
  submissionCompletedAt: string,
  receivedAt: string | null,
  code: string,
  observed: string
): FinalStageResult {
  return baseResult(
    stage,
    "failed",
    new Date(submissionCompletedAt).toISOString(),
    receivedAt ? new Date(receivedAt).toISOString() : new Date().toISOString(),
    observed,
    code
  )
}

function passedStage(stage: WorkflowStage, started: number, observed: string): FinalStageResult {
  const completed = Date.now()
  const degraded = Boolean(stage.timingThresholdMs && completed - started > stage.timingThresholdMs)
  return baseResult(stage, degraded ? "degraded" : "passed", new Date(started).toISOString(), new Date(completed).toISOString(), observed, null)
}

function failedStage(stage: WorkflowStage, code: string, observed: string, started = Date.now()): FinalStageResult {
  const completed = Date.now()
  return baseResult(stage, "failed", new Date(started).toISOString(), new Date(completed).toISOString(), observed, code)
}

function inconclusiveStage(stage: WorkflowStage, code: string, observed: string): FinalStageResult {
  const at = new Date().toISOString()
  return baseResult(stage, "inconclusive", at, at, observed, code)
}

function cancelledStage(stage: WorkflowStage, observed: string): FinalStageResult {
  const at = new Date().toISOString()
  return baseResult(stage, "cancelled", at, at, observed, "CANCELLED")
}

function notRunStage(stage: WorkflowStage, observed: string): FinalStageResult {
  const at = new Date().toISOString()
  return baseResult(stage, "not_run", at, at, observed, null)
}

function baseResult(
  stage: WorkflowStage,
  verdict: FinalStageResult["verdict"],
  startedAt: string,
  completedAt: string,
  observed: string,
  errorCode: string | null
): FinalStageResult {
  return {
    stageId: stage.id,
    verdict,
    startedAt,
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
    expected: stage.expected,
    observed,
    errorCode,
    diagnostics: {},
    assertionResults: [createRunnerAssertionResult({
      assertionId: `stage:${stage.id}`,
      required: stage.required,
      expectedRule: stage.expected,
      safeObservation: observed,
      result: verdict,
      evaluatedAt: completedAt,
    })],
    evidenceArtifactIds: [],
  }
}

function safeSessionSummary(session: BrowserSessionHandle, currentUrl: string) {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    currentHost: safeHost(currentUrl),
  }
}

function workflowWorkerId(input: EvalWorkflowInput) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.workflowAttemptToken)) {
    throw new Error("A unique workflow attempt token is required.")
  }
  return `workflow:${input.evalRunId}:${input.workflowAttemptToken}`
}

function emailOutcomeFromTiming(event: SignedEmailEvent, timing: EmailTimingResult): EvalEmailOutcome {
  if (timing.status === "on_time" || timing.status === "late" || timing.status === "too_late") {
    return { ...event, timing: timing.status, latencyMs: timing.latencyMs }
  }
  return timing.status === "invalid"
    ? { kind: "invalid", reason: timing.reason }
    : { kind: "timeout" }
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${milliseconds} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} seconds`
}

function safeHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function databaseArtifactKind(kind: string) {
  if (kind === "dom_summary") return "dom_snapshot"
  if (kind === "network_summary") return "network_log"
  return kind
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim() ?? ""
  if (!value) throw new Error(`${name} is required for business eval runs.`)
  return value
}

function requireSecret(name: string) {
  const value = requireEnv(name)
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters.`)
  return value
}

function safeError(error: unknown) {
  return error instanceof Error
    ? error.message.replaceAll(/(?:https?|wss?):\/\/[^\s]+/gi, "[redacted-url]").slice(0, 1_000)
    : "The operation did not complete."
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
