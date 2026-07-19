export type EmailTimingResult =
  | { status: "pending"; baselineAt: string; deadlineAt: string; remainingMs: number }
  | { status: "timeout"; baselineAt: string; deadlineAt: string; latencyMs: null }
  | { status: "on_time" | "late" | "too_late"; baselineAt: string; deadlineAt: string; receivedAt: string; latencyMs: number }
  | { status: "invalid"; reason: string }

export function classifyEmailTiming(input: {
  submissionCompletedAt: string
  thresholdSeconds: number
  maximumWaitSeconds?: number
  receivedAt?: string | null
  nowMs?: number
}): EmailTimingResult {
  const baselineMs = Date.parse(input.submissionCompletedAt)
  if (!Number.isFinite(baselineMs)) return { status: "invalid", reason: "The persisted submission completion time is invalid." }
  if (!Number.isInteger(input.thresholdSeconds) || input.thresholdSeconds < 1 || input.thresholdSeconds > 3_600) {
    return { status: "invalid", reason: "The email timing threshold is invalid." }
  }
  const maximumWaitSeconds = input.maximumWaitSeconds ?? input.thresholdSeconds
  if (!Number.isInteger(maximumWaitSeconds) || maximumWaitSeconds < input.thresholdSeconds || maximumWaitSeconds > 3_600) {
    return { status: "invalid", reason: "The final email wait boundary is invalid." }
  }

  const thresholdMs = input.thresholdSeconds * 1_000
  const maximumWaitMs = maximumWaitSeconds * 1_000
  const deadlineMs = baselineMs + maximumWaitMs
  const baselineAt = new Date(baselineMs).toISOString()
  const deadlineAt = new Date(deadlineMs).toISOString()

  if (input.receivedAt) {
    const receivedMs = Date.parse(input.receivedAt)
    if (!Number.isFinite(receivedMs)) return { status: "invalid", reason: "The signed inbound email time is invalid." }
    if (receivedMs < baselineMs) {
      return { status: "invalid", reason: "The signed inbound email predates the persisted submission completion." }
    }
    const latencyMs = receivedMs - baselineMs
    return {
      status: latencyMs <= thresholdMs ? "on_time" : latencyMs <= maximumWaitMs ? "late" : "too_late",
      baselineAt,
      deadlineAt,
      receivedAt: new Date(receivedMs).toISOString(),
      latencyMs,
    }
  }

  const remainingMs = Math.max(0, deadlineMs - (input.nowMs ?? Date.now()))
  return remainingMs > 0
    ? { status: "pending", baselineAt, deadlineAt, remainingMs }
    : { status: "timeout", baselineAt, deadlineAt, latencyMs: null }
}
