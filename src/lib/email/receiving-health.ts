export const EMAIL_RECEIVING_HEALTH_FRESHNESS_MS = 5 * 60 * 1_000

export type EmailReceivingHealth =
  | { status: "healthy"; observedAt: string }
  | { status: "unknown"; reason: string }

export function classifyEmailReceivingHealth(input: {
  submissionCompletedAt: string
  maximumWaitSeconds: number
  observedAt?: string | null
}): EmailReceivingHealth {
  const submissionMs = Date.parse(input.submissionCompletedAt)
  if (!Number.isFinite(submissionMs)) {
    return { status: "unknown", reason: "The persisted submission completion time is invalid." }
  }
  if (!Number.isInteger(input.maximumWaitSeconds) || input.maximumWaitSeconds < 1 || input.maximumWaitSeconds > 3_600) {
    return { status: "unknown", reason: "The final email wait boundary is invalid." }
  }
  if (!input.observedAt) {
    return { status: "unknown", reason: "No verified Resend receiving-health event covered the assertion window." }
  }

  const observedMs = Date.parse(input.observedAt)
  if (!Number.isFinite(observedMs)) {
    return { status: "unknown", reason: "The Resend receiving-health event time is invalid." }
  }
  const deadlineMs = submissionMs + input.maximumWaitSeconds * 1_000
  const healthyWindowStartMs = deadlineMs - EMAIL_RECEIVING_HEALTH_FRESHNESS_MS
  if (observedMs < healthyWindowStartMs || observedMs > deadlineMs) {
    return { status: "unknown", reason: "No recent verified Resend receiving-health event covered the assertion deadline." }
  }

  return { status: "healthy", observedAt: new Date(observedMs).toISOString() }
}
