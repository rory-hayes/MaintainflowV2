export type AssertionTransitionBaseline = {
  satisfiedBeforeAction: boolean | null
  sourceActionId: string
  capturedAt: string
}

export type AssertionTransitionViolation = {
  code: "TRANSITION_BASELINE_MISSING" | "TRANSITION_BASELINE_UNAVAILABLE" | "PREEXISTING_ASSERTION_STATE"
  message: string
}

export function assertionTransitionViolation(
  baseline: AssertionTransitionBaseline | undefined
): AssertionTransitionViolation | null {
  if (!baseline) {
    return {
      code: "TRANSITION_BASELINE_MISSING",
      message: "No trustworthy pre-action baseline was captured for this outcome assertion.",
    }
  }
  if (baseline.satisfiedBeforeAction === null) {
    return {
      code: "TRANSITION_BASELINE_UNAVAILABLE",
      message: "The runner could not establish the outcome state before the approved action.",
    }
  }
  if (baseline.satisfiedBeforeAction) {
    return {
      code: "PREEXISTING_ASSERTION_STATE",
      message: "The configured outcome was already satisfied before the approved action, so the action could not be proven to produce it.",
    }
  }
  return null
}

export function urlMatchesPublishedPattern(url: string, pattern: string) {
  if (!pattern.includes("*")) return normalizedUrl(url) === normalizedUrl(pattern)
  const doubleStarToken = "__MAINTAIN_FLOW_DOUBLE_STAR__"
  const escaped = pattern
    .replaceAll("**", doubleStarToken)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll(doubleStarToken, ".*")
  try {
    return new RegExp(`^${escaped}$`).test(url)
  } catch {
    return false
  }
}

function normalizedUrl(value: string) {
  try {
    return new URL(value).toString()
  } catch {
    return value
  }
}
