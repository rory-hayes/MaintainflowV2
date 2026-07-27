export const BROWSERBASE_USAGE_WARNING_PERCENT_DEFAULT = 80
export const BROWSERBASE_SESSION_METERING_RETRY_BATCH_SIZE = 4

const TERMINAL_SESSION_STATUSES = new Set(["COMPLETED", "ERROR", "TIMED_OUT"])

export type BrowserbaseCommercialGuardConfig = {
  monthlyBrowserMinutesLimit: number
  monthlyProxyBytesLimit: number
  warningPercent: number
}

export type BrowserbaseProjectUsage = {
  browserMinutes: number
  proxyBytes: number
}

export type BrowserbaseUsageGuardVerdict = {
  status: "healthy" | "warning" | "blocked"
  reason: "" | "browser_minutes_warning" | "proxy_bytes_warning" | "browser_minutes_limit" | "proxy_bytes_limit"
  mayCreateSession: boolean
}

export type BrowserbaseSessionUsageInput = {
  projectId: string
  startedAt: string
  endedAt?: string
  status: string
  proxyBytes: number
}

export type BrowserbaseSessionUsage = {
  startedAt: string
  endedAt: string
  durationMs: number
  activeMinutes: number
  proxyBytes: number
  status: "COMPLETED" | "ERROR" | "TIMED_OUT"
}

export type BrowserbaseSessionMeteringPolicy = {
  maxAttempts: number
  maxAgeMinutes: number
}

export type BrowserbaseTerminalPollResult =
  | { kind: "terminal"; attempts: number; session: BrowserbaseSessionUsageInput }
  | { kind: "pending"; attempts: number; session: BrowserbaseSessionUsageInput }

export function parseBrowserbaseCommercialGuardConfig(
  env: Partial<Record<string, string | undefined>>
): BrowserbaseCommercialGuardConfig {
  return {
    monthlyBrowserMinutesLimit: positiveSafeInteger(
      env.BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT,
      "BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT"
    ),
    monthlyProxyBytesLimit: positiveSafeInteger(
      env.BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT,
      "BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT"
    ),
    warningPercent: warningPercent(env.BROWSERBASE_USAGE_WARNING_PERCENT),
  }
}

export function parseBrowserbaseSessionMeteringPolicy(
  env: Partial<Record<string, string | undefined>>
): BrowserbaseSessionMeteringPolicy {
  const maxAttempts = positiveSafeInteger(
    env.BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS,
    "BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS"
  )
  const maxAgeMinutes = positiveSafeInteger(
    env.BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES,
    "BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES"
  )
  if (maxAttempts < 3 || maxAttempts > 100) {
    throw new Error("BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS must be between 3 and 100.")
  }
  if (maxAgeMinutes < 15 || maxAgeMinutes > 1_440) {
    throw new Error("BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES must be between 15 and 1440.")
  }
  return { maxAttempts, maxAgeMinutes }
}

export function browserbaseUsageGuardVerdict(
  usage: BrowserbaseProjectUsage,
  config: BrowserbaseCommercialGuardConfig
): BrowserbaseUsageGuardVerdict {
  assertProjectUsage(usage)
  if (usage.browserMinutes >= config.monthlyBrowserMinutesLimit) {
    return { status: "blocked", reason: "browser_minutes_limit", mayCreateSession: false }
  }
  if (usage.proxyBytes >= config.monthlyProxyBytesLimit) {
    return { status: "blocked", reason: "proxy_bytes_limit", mayCreateSession: false }
  }
  const minuteWarning = usage.browserMinutes * 100 >= config.monthlyBrowserMinutesLimit * config.warningPercent
  const proxyWarning = usage.proxyBytes * 100 >= config.monthlyProxyBytesLimit * config.warningPercent
  if (minuteWarning || proxyWarning) {
    return {
      status: "warning",
      reason: minuteWarning ? "browser_minutes_warning" : "proxy_bytes_warning",
      mayCreateSession: true,
    }
  }
  return { status: "healthy", reason: "", mayCreateSession: true }
}

export function deriveBrowserbaseSessionUsage(
  session: BrowserbaseSessionUsageInput,
  expectedProjectId: string
): BrowserbaseSessionUsage {
  if (!expectedProjectId || session.projectId !== expectedProjectId) {
    throw new Error("The Browserbase usage record belongs to a different reviewed project.")
  }
  if (!TERMINAL_SESSION_STATUSES.has(session.status) || !session.endedAt) {
    throw new Error("Browserbase has not returned a terminal, metered session record.")
  }
  const startedAtMs = Date.parse(session.startedAt)
  const endedAtMs = Date.parse(session.endedAt)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    throw new Error("Browserbase returned invalid session timing metadata.")
  }
  if (!Number.isSafeInteger(session.proxyBytes) || session.proxyBytes < 0) {
    throw new Error("Browserbase returned invalid session proxy-byte usage.")
  }
  const durationMs = endedAtMs - startedAtMs
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs,
    activeMinutes: durationMs / 60_000,
    proxyBytes: session.proxyBytes,
    status: session.status as BrowserbaseSessionUsage["status"],
  }
}

export async function pollBrowserbaseTerminalSession(input: {
  retrieve: () => Promise<BrowserbaseSessionUsageInput>
  expectedProjectId: string
  delaysMs: readonly number[]
  sleep?: (delayMs: number) => Promise<void>
}): Promise<BrowserbaseTerminalPollResult> {
  if (!input.delaysMs.length) throw new Error("At least one Browserbase metering poll is required.")
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  let latest: BrowserbaseSessionUsageInput | undefined
  for (const [index, delayMs] of input.delaysMs.entries()) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
      throw new Error("Browserbase metering poll delays must be bounded safe integers.")
    }
    if (delayMs) await sleep(delayMs)
    latest = await input.retrieve()
    if (latest.projectId !== input.expectedProjectId) {
      throw new Error("The Browserbase session belongs to a different reviewed project.")
    }
    if (latest.endedAt && TERMINAL_SESSION_STATUSES.has(latest.status)) {
      return { kind: "terminal", attempts: index + 1, session: latest }
    }
  }
  if (!latest) throw new Error("Browserbase did not return the provider session.")
  return { kind: "pending", attempts: input.delaysMs.length, session: latest }
}

export function browserbaseSessionMeteringRetryDelaySeconds(attemptCount: number) {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    throw new Error("Browserbase metering attempt count is invalid.")
  }
  return Math.min(600, 30 * (2 ** Math.min(attemptCount, 5)))
}

export function browserbaseSessionMeteringShouldEscalate(input: {
  attemptCount: number
  firstPendingAt: string
  nowMs?: number
}, policy: BrowserbaseSessionMeteringPolicy) {
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
    throw new Error("Browserbase metering attempt count is invalid.")
  }
  const firstPendingAtMs = Date.parse(input.firstPendingAt)
  const nowMs = input.nowMs ?? Date.now()
  if (!Number.isFinite(firstPendingAtMs) || !Number.isFinite(nowMs) || nowMs < firstPendingAtMs) {
    throw new Error("Browserbase metering pending timestamps are invalid.")
  }
  return input.attemptCount >= policy.maxAttempts
    || nowMs - firstPendingAtMs >= policy.maxAgeMinutes * 60_000
}

export function browserbaseDailyReconciliationDue(lastDailyReconciledAt: string | null, nowMs = Date.now()) {
  if (!lastDailyReconciledAt) return true
  const prior = Date.parse(lastDailyReconciledAt)
  return !Number.isFinite(prior) || nowMs - prior >= 24 * 60 * 60_000
}

function positiveSafeInteger(value: string | undefined, key: string) {
  const normalized = value?.trim() ?? ""
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${key} must be an explicit positive integer commercial ceiling.`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} must fit inside a safe integer.`)
  }
  return parsed
}

function warningPercent(value: string | undefined) {
  if (!value?.trim()) return BROWSERBASE_USAGE_WARNING_PERCENT_DEFAULT
  const parsed = positiveSafeInteger(value, "BROWSERBASE_USAGE_WARNING_PERCENT")
  if (parsed < 50 || parsed > 95) {
    throw new Error("BROWSERBASE_USAGE_WARNING_PERCENT must be between 50 and 95.")
  }
  return parsed
}

function assertProjectUsage(usage: BrowserbaseProjectUsage) {
  if (!Number.isSafeInteger(usage.browserMinutes) || usage.browserMinutes < 0) {
    throw new Error("Browserbase returned invalid project browser-minute usage.")
  }
  if (!Number.isSafeInteger(usage.proxyBytes) || usage.proxyBytes < 0) {
    throw new Error("Browserbase returned invalid project proxy-byte usage.")
  }
}
