import type { EvalCleanupStatus, EvalSchedulePolicy, JourneyDefinitionDraft, JourneyTemplate } from "./types.ts"

export const DEFAULT_EVAL_INTERVAL_MINUTES = 24 * 60
export const MIN_EVAL_INTERVAL_MINUTES = 60
export const MIN_TRIAL_SIGNUP_INTERVAL_MINUTES = 6 * 60
export const MAX_EVAL_INTERVAL_MINUTES = 31 * 24 * 60

export function minimumEvalIntervalMinutes(template: JourneyTemplate) {
  return template === "trial_signup" ? MIN_TRIAL_SIGNUP_INTERVAL_MINUTES : MIN_EVAL_INTERVAL_MINUTES
}

export function normalizeEvalSchedulePolicy(
  input: Partial<EvalSchedulePolicy> = {},
  template: JourneyTemplate = "lead_form",
): EvalSchedulePolicy {
  const intervalMinutes = input.intervalMinutes ?? DEFAULT_EVAL_INTERVAL_MINUTES
  const minimum = minimumEvalIntervalMinutes(template)
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < minimum || intervalMinutes > MAX_EVAL_INTERVAL_MINUTES) {
    throw new Error(`Eval schedules must run every ${minimum} to ${MAX_EVAL_INTERVAL_MINUTES} minutes.`)
  }
  return {
    intervalMinutes,
    enabled: input.enabled ?? true,
    cleanupRequired: input.cleanupRequired ?? true,
  }
}

export function scheduleStateAfterCleanup(status: EvalCleanupStatus) {
  return status === "failed"
    ? { enabled: false, pauseReason: "cleanup_failed" as const }
    : { enabled: true, pauseReason: "" as const }
}

export function assertJourneyCleanupPolicy(definition: JourneyDefinitionDraft) {
  const cleanupStages = definition.stages.filter((stage) => stage.cleanup)
  const cleanupStageIsRestricted = cleanupStages.every((stage) => {
    const cleanupActions = stage.actions.filter((action) => action.type === "cleanup")
    const confirmationActions = stage.actions.filter((action) =>
      action.type === "wait_for_url" || action.type === "wait_for_text" || action.type === "assert_visible"
    )
    if (cleanupActions.length !== 1 || cleanupActions.length + confirmationActions.length !== stage.actions.length) {
      return false
    }
    const cleanupIndex = stage.actions.indexOf(cleanupActions[0])
    const cleanup = cleanupActions[0]
    return cleanup.type === "cleanup" && cleanup.mode === "webhook"
      ? confirmationActions.length === 0
      : confirmationActions.length > 0
        && confirmationActions.every((action) => stage.actions.indexOf(action) > cleanupIndex)
  })
  if (definition.template === "trial_signup") {
    if (cleanupStages.length !== 1 || definition.stages.at(-1)?.cleanup !== true || !cleanupStageIsRestricted) {
      throw new Error("Trial-signup journeys require exactly one final cleanup stage using in_product or webhook cleanup.")
    }
  } else if (cleanupStages.length > 1) {
    throw new Error("A journey can define at most one cleanup stage.")
  } else if (cleanupStages.length === 1 && !cleanupStageIsRestricted) {
    throw new Error("Cleanup stages require one restricted cleanup action and, for in-product cleanup, a deterministic confirmation after it.")
  }
  return definition
}

export function quotaPeriodStart(date: Date | string) {
  const value = typeof date === "string" ? new Date(date) : date
  if (Number.isNaN(value.getTime())) throw new Error("A valid quota date is required.")
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-01`
}
