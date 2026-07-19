import type { EvalVerdict } from "./types.ts"

/**
 * Exact business-eval reduction order. A conclusive failure outranks runner
 * uncertainty; uncertainty outranks degradation; cancellation outranks an
 * otherwise unstarted run. Only an all-passed run is passed.
 */
export function reduceEvalVerdicts(verdicts: readonly EvalVerdict[]): EvalVerdict {
  if (verdicts.length === 0) return "not_run"
  if (verdicts.includes("failed")) return "failed"
  if (verdicts.includes("inconclusive")) return "inconclusive"
  if (verdicts.includes("degraded")) return "degraded"
  if (verdicts.includes("cancelled")) return "cancelled"
  if (verdicts.every((verdict) => verdict === "passed")) return "passed"
  return "not_run"
}
