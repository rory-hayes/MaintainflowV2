import "server-only"

import { createHash, randomBytes } from "node:crypto"

import Browserbase from "@browserbasehq/sdk"

import { requestBrowserbaseSessionReleaseIfStranded } from "@/lib/runner/browserbase-lifecycle.server"
import { supabaseServiceJson } from "@/lib/supabase/server"
import {
  BROWSERBASE_SESSION_METERING_RETRY_BATCH_SIZE,
  browserbaseSessionMeteringRetryDelaySeconds,
  browserbaseUsageGuardVerdict,
  deriveBrowserbaseSessionUsage,
  parseBrowserbaseCommercialGuardConfig,
  parseBrowserbaseSessionMeteringPolicy,
  pollBrowserbaseTerminalSession,
  type BrowserbaseCommercialGuardConfig,
  type BrowserbaseSessionMeteringPolicy,
  type BrowserbaseSessionUsageInput,
} from "@/lib/runner/browserbase-usage-policy"

type Row = Record<string, unknown>

const TERMINAL_USAGE_POLL_DELAYS_MS = [0, 250, 500, 1_000, 2_000] as const

export type BrowserbaseUsagePurpose =
  | { kind: "eval_run"; agencyId?: never; evalRunId: string; projectId?: never }
  | { kind: "page_scan"; agencyId: string; evalRunId?: never; projectId: string }

export type BrowserbaseSessionCreationIntent = {
  id: string
  correlationToken: string
  purpose: BrowserbaseUsagePurpose
}

export type BrowserbaseSessionMeteringRegistration = {
  browserbaseProjectId: string
  providerSessionId: string
  purpose: BrowserbaseUsagePurpose
  creationIntentId: string
  workerId: string
  meteringState: string
  attemptCount: number
  durationMs: number | null
  proxyBytes: number | null
}

export type BrowserbaseCostControlState = {
  status: "pending" | "healthy" | "warning" | "blocked" | "provider_error" | "metering_error"
  reason: string
  mayCreateSession: boolean
  browserMinutes: number
  proxyBytes: number
  sampledAt: string | null
}

export class BrowserbaseUsageGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserbaseUsageGuardError"
  }
}

export async function assertBrowserbaseSessionCommerciallyAllowed(input: {
  client: Browserbase
  projectId: string
  env?: Partial<Record<string, string | undefined>>
}) {
  const env = input.env ?? process.env
  const config = parseBrowserbaseCommercialGuardConfig(env)
  parseBrowserbaseSessionMeteringPolicy(env)
  const workerId = `browserbase-usage-preflight:${crypto.randomUUID()}`
  const claim = await claimBrowserbaseProjectUsageSample({
    projectId: input.projectId,
    workerId,
    config,
  })
  if (!claim.claimed) {
    throw new BrowserbaseUsageGuardError("Managed browser usage is already being verified; no new browser session was created.")
  }
  const usage = await sampleProjectUsage(input.client, input.projectId).catch(async () => {
    await markBrowserbaseUsageControlFailure({
      projectId: input.projectId,
      config,
      reason: "project_usage_unavailable",
      permanent: false,
      workerId,
    })
    throw new BrowserbaseUsageGuardError("Managed browser usage could not be verified, so no new browser session was created.")
  })
  const expected = browserbaseUsageGuardVerdict(usage, config)
  const state = await persistProjectUsage({
    projectId: input.projectId,
    usage,
    config,
    source: "session_preflight",
    workerId,
  })
  if (!expected.mayCreateSession || !state.mayCreateSession) {
    throw new BrowserbaseUsageGuardError("Managed browser capacity reached its reviewed safety ceiling; no new browser session was created.")
  }
  return state
}

export async function prepareBrowserbaseSessionCreation(input: {
  browserbaseProjectId: string
  purpose: BrowserbaseUsagePurpose
}) : Promise<BrowserbaseSessionCreationIntent> {
  const correlationToken = randomBytes(24).toString("base64url")
  const rows = await supabaseServiceJson<Row[]>("rpc/prepare_browser_provider_session_creation", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_correlation_token: correlationToken,
      p_agency_id: input.purpose.kind === "page_scan" ? input.purpose.agencyId : null,
      p_eval_run_id: input.purpose.kind === "eval_run" ? input.purpose.evalRunId : null,
      p_client_id: input.purpose.kind === "page_scan" ? input.purpose.projectId : null,
      p_purpose: input.purpose.kind,
    }),
  })
  const row = rows[0]
  if (!row?.creation_intent_id || row.correlation_token !== correlationToken) {
    throw new BrowserbaseUsageGuardError("Managed browser session creation could not be prepared durably; no browser session was created.")
  }
  return {
    id: String(row.creation_intent_id),
    correlationToken,
    purpose: input.purpose,
  }
}

export async function markBrowserbaseSessionCreationUncertain(input: {
  browserbaseProjectId: string
  creationIntentId: string
  reason: "create_response_ambiguous" | "ledger_registration_failed"
}) {
  await supabaseServiceJson("rpc/mark_browser_provider_session_creation_uncertain", {
    method: "POST",
    body: JSON.stringify({
      p_creation_intent_id: input.creationIntentId,
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_reason: input.reason,
    }),
  })
}

export async function registerBrowserbaseSessionForMetering(input: {
  client: Browserbase
  browserbaseProjectId: string
  providerSessionId: string
  creationIntent: BrowserbaseSessionCreationIntent
  env?: Partial<Record<string, string | undefined>>
}): Promise<BrowserbaseSessionMeteringRegistration> {
  const env = input.env ?? process.env
  const config = parseBrowserbaseCommercialGuardConfig(env)
  parseBrowserbaseSessionMeteringPolicy(env)
  const workerId = `browserbase-session-active:${crypto.randomUUID()}`
  try {
    const rows = await supabaseServiceJson<Row[]>("rpc/register_browser_provider_session_metering", {
      method: "POST",
      body: JSON.stringify({
        p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
        p_provider_session_id: input.providerSessionId,
        p_agency_id: input.creationIntent.purpose.kind === "page_scan" ? input.creationIntent.purpose.agencyId : null,
        p_eval_run_id: input.creationIntent.purpose.kind === "eval_run" ? input.creationIntent.purpose.evalRunId : null,
        p_client_id: input.creationIntent.purpose.kind === "page_scan" ? input.creationIntent.purpose.projectId : null,
        p_purpose: input.creationIntent.purpose.kind,
        p_creation_intent_id: input.creationIntent.id,
        p_correlation_token: input.creationIntent.correlationToken,
        p_worker_id: workerId,
        p_active_timeout_seconds: 360,
      }),
    })
    const row = rows[0]
    if (!row) throw new Error("missing durable registration")
    return {
      browserbaseProjectId: input.browserbaseProjectId,
      providerSessionId: input.providerSessionId,
      purpose: input.creationIntent.purpose,
      creationIntentId: input.creationIntent.id,
      workerId,
      meteringState: String(row.metering_state ?? ""),
      attemptCount: Number(row.attempt_count ?? 0),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      proxyBytes: row.proxy_bytes == null ? null : Number(row.proxy_bytes),
    }
  } catch {
    await Promise.allSettled([
      markBrowserbaseSessionCreationUncertain({
        browserbaseProjectId: input.browserbaseProjectId,
        creationIntentId: input.creationIntent.id,
        reason: "ledger_registration_failed",
      }),
      requestBrowserbaseSessionReleaseIfStranded(
        input.client,
        input.providerSessionId,
        input.browserbaseProjectId
      ),
      markBrowserbaseUsageControlFailure({
        projectId: input.browserbaseProjectId,
        config,
        reason: "session_usage_conflict",
        permanent: false,
      }),
    ])
    throw new BrowserbaseUsageGuardError("Managed browser usage could not be registered durably; the provider session was stopped and browser execution is paused safely.")
  }
}

export async function recordTerminalBrowserbaseSessionUsage(input: {
  client: Browserbase
  registration: BrowserbaseSessionMeteringRegistration
  env?: Partial<Record<string, string | undefined>>
}) {
  const env = input.env ?? process.env
  parseBrowserbaseCommercialGuardConfig(env)
  const policy = parseBrowserbaseSessionMeteringPolicy(env)
  if (input.registration.meteringState === "permanent_error") {
    throw new BrowserbaseUsageGuardError("Managed browser usage has an unresolved permanent metering fault; browser execution is paused safely.")
  }
  if (input.registration.meteringState === "resolved") {
    return {
      status: "recorded" as const,
      durationMs: Number(input.registration.durationMs ?? 0),
      activeMinutes: Number(input.registration.durationMs ?? 0) / 60_000,
      proxyBytes: Number(input.registration.proxyBytes ?? 0),
      replayed: true,
    }
  }

  const begun = await beginBrowserbaseSessionTerminalMetering(input.registration)
  if (begun.meteringState === "permanent_error") {
    throw new BrowserbaseUsageGuardError("Managed browser usage has an unresolved permanent metering fault; browser execution is paused safely.")
  }
  if (begun.meteringState === "resolved") {
    return { status: "recorded" as const, durationMs: 0, activeMinutes: 0, proxyBytes: 0, replayed: true }
  }

  let poll
  try {
    poll = await pollBrowserbaseTerminalSession({
      retrieve: () => retrieveBrowserbaseSession(input.client, input.registration.providerSessionId),
      expectedProjectId: input.registration.browserbaseProjectId,
      delaysMs: TERMINAL_USAGE_POLL_DELAYS_MS,
    })
  } catch {
    return deferBrowserbaseSessionMeteringOrThrow({
      browserbaseProjectId: input.registration.browserbaseProjectId,
      providerSessionId: input.registration.providerSessionId,
      workerId: input.registration.workerId,
      policy,
      priorAttemptCount: begun.attemptCount,
      errorCode: "provider_unavailable",
    })
  }
  if (poll.kind === "pending") {
    return deferBrowserbaseSessionMeteringOrThrow({
      browserbaseProjectId: input.registration.browserbaseProjectId,
      providerSessionId: input.registration.providerSessionId,
      workerId: input.registration.workerId,
      policy,
      priorAttemptCount: begun.attemptCount,
      errorCode: "not_terminal",
    })
  }
  return persistTerminalBrowserbaseSessionUsage({
    browserbaseProjectId: input.registration.browserbaseProjectId,
    providerSessionId: input.registration.providerSessionId,
    purpose: input.registration.purpose,
    terminal: poll.session,
  })
}

export async function reconcileBrowserbaseProjectUsageIfDue(
  env: Partial<Record<string, string | undefined>> = process.env
): Promise<{
  due: boolean
  state: BrowserbaseCostControlState
  sessionCreation: { claimed: number; registered: number; absent: number; deferred: number; escalated: number }
  sessionMetering: { claimed: number; resolved: number; deferred: number; escalated: number }
}> {
  const apiKey = env.BROWSERBASE_API_KEY?.trim() ?? ""
  const projectId = env.BROWSERBASE_PROJECT_ID?.trim() ?? ""
  if (!apiKey || !projectId) {
    throw new Error("Browserbase usage reconciliation is not configured.")
  }
  const config = parseBrowserbaseCommercialGuardConfig(env)
  const meteringPolicy = parseBrowserbaseSessionMeteringPolicy(env)
  const client = new Browserbase({ apiKey, maxRetries: 0, timeout: 10_000 })
  const sessionCreation = await reconcileUncertainBrowserbaseSessionCreations({
    client,
    browserbaseProjectId: projectId,
    policy: meteringPolicy,
    env,
  })
  const sessionMetering = await reconcilePendingBrowserbaseSessionUsage({
    client,
    browserbaseProjectId: projectId,
    policy: meteringPolicy,
  })
  const workerId = `browserbase-usage:${crypto.randomUUID()}`
  const claims = await supabaseServiceJson<Row[]>("rpc/claim_browser_provider_daily_reconciliation", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(projectId),
      p_worker_id: workerId,
      p_browser_minutes_limit: config.monthlyBrowserMinutesLimit,
      p_proxy_bytes_limit: config.monthlyProxyBytesLimit,
      p_warning_percent: config.warningPercent,
      p_lease_seconds: 120,
    }),
  })
  const claim = claims[0]
  if (!claim) throw new Error("Browserbase usage reconciliation did not return a control state.")
  if (claim.claimed !== true) {
    return { due: false, state: presentControlState(claim), sessionCreation, sessionMetering }
  }

  try {
    const usage = await sampleProjectUsage(client, projectId)
    return {
      due: true,
      state: await persistProjectUsage({
        projectId,
        usage,
        config,
        source: "daily_reconciliation",
        workerId,
      }),
      sessionCreation,
      sessionMetering,
    }
  } catch {
    await markBrowserbaseUsageControlFailure({
      projectId,
      config,
      reason: "daily_reconciliation_unavailable",
      permanent: false,
      workerId,
    })
    throw new Error("Daily Browserbase usage reconciliation failed closed.")
  }
}

export async function getWorkspaceBrowserProviderUsage(agencyId: string, env: Partial<Record<string, string | undefined>> = process.env) {
  const projectId = env.BROWSERBASE_PROJECT_ID?.trim() ?? ""
  if (!projectId) {
    return {
      sessionActiveMinutes: 0,
      proxyBytes: 0,
      proxyMegabytes: 0,
      sessions: 0,
      measuredThrough: null,
      status: "pending" as const,
      warning: "Browser usage metering is not connected yet.",
    }
  }
  const rows = await supabaseServiceJson<Row[]>("rpc/get_browser_provider_workspace_usage", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: agencyId,
      p_project_key: browserbaseProjectKey(projectId),
    }),
  })
  const row = rows[0] ?? {}
  const rawStatus = String(row.control_status ?? "pending")
  const status = rawStatus === "healthy" ? "healthy" as const
    : rawStatus === "warning" ? "warning" as const
      : rawStatus === "pending" ? "pending" as const
        : "paused" as const
  return {
    sessionActiveMinutes: Number(row.session_active_minutes ?? 0),
    proxyBytes: Number(row.proxy_bytes ?? 0),
    proxyMegabytes: Number(row.proxy_megabytes ?? 0),
    sessions: Number(row.session_count ?? 0),
    measuredThrough: row.measured_through ? String(row.measured_through) : null,
    status,
    warning: customerSafeUsageWarning(status),
  }
}

export function browserbaseProjectKey(projectId: string) {
  const normalized = projectId.trim()
  if (!normalized) throw new Error("BROWSERBASE_PROJECT_ID is required for usage accounting.")
  return createHash("sha256").update(`browserbase-project:v1:${normalized}`).digest("hex")
}

async function beginBrowserbaseSessionTerminalMetering(
  registration: BrowserbaseSessionMeteringRegistration
) {
  const rows = await supabaseServiceJson<Row[]>("rpc/begin_browser_provider_session_terminal_metering", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(registration.browserbaseProjectId),
      p_provider_session_id: registration.providerSessionId,
      p_worker_id: registration.workerId,
      p_lease_seconds: 30,
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Browserbase terminal metering could not acquire its durable request lease.")
  return {
    meteringState: String(row.metering_state ?? ""),
    attemptCount: Number(row.attempt_count ?? 0),
  }
}

async function persistTerminalBrowserbaseSessionUsage(input: {
  browserbaseProjectId: string
  providerSessionId: string
  purpose: BrowserbaseUsagePurpose
  terminal: BrowserbaseSessionUsageInput
}) {
  const usage = deriveBrowserbaseSessionUsage(input.terminal, input.browserbaseProjectId)
  const rows = await supabaseServiceJson<Row[]>("rpc/record_browser_provider_session_usage", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_provider_session_id: input.providerSessionId,
      p_agency_id: input.purpose.kind === "page_scan" ? input.purpose.agencyId : null,
      p_eval_run_id: input.purpose.kind === "eval_run" ? input.purpose.evalRunId : null,
      p_client_id: input.purpose.kind === "page_scan" ? input.purpose.projectId : null,
      p_purpose: input.purpose.kind,
      p_started_at: usage.startedAt,
      p_ended_at: usage.endedAt,
      p_proxy_bytes: usage.proxyBytes,
      p_provider_status: usage.status,
    }),
  })
  const row = rows[0]
  if (!row || row.metering_ok !== true) {
    throw new Error("The provider session usage did not match its durable accounting record.")
  }
  return {
    status: "recorded" as const,
    durationMs: Number(row.duration_ms ?? usage.durationMs),
    activeMinutes: usage.activeMinutes,
    proxyBytes: usage.proxyBytes,
    replayed: Boolean(row.replayed),
  }
}

async function deferBrowserbaseSessionMeteringOrThrow(input: {
  browserbaseProjectId: string
  providerSessionId: string
  workerId: string | null
  policy: BrowserbaseSessionMeteringPolicy
  priorAttemptCount: number
  errorCode: "not_terminal" | "provider_unavailable" | "invalid_terminal_record"
  throwOnEscalation?: boolean
}) {
  const rows = await supabaseServiceJson<Row[]>("rpc/defer_browser_provider_session_metering", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_provider_session_id: input.providerSessionId,
      p_worker_id: input.workerId,
      p_max_attempts: input.policy.maxAttempts,
      p_max_age_minutes: input.policy.maxAgeMinutes,
      p_retry_delay_seconds: browserbaseSessionMeteringRetryDelaySeconds(input.priorAttemptCount),
      p_error_code: input.errorCode,
      p_attempted_at: new Date().toISOString(),
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Browserbase session metering retry state was not persisted.")
  const escalated = row.escalated === true || String(row.metering_state) === "permanent_error"
  if (escalated && input.throwOnEscalation !== false) {
    throw new BrowserbaseUsageGuardError("Managed browser usage exceeded its reviewed reconciliation window; browser execution is paused safely.")
  }
  return {
    status: escalated ? "permanent_error" as const : "pending" as const,
    attemptCount: Number(row.attempt_count ?? input.priorAttemptCount + 1),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    escalated,
  }
}

async function reconcileUncertainBrowserbaseSessionCreations(input: {
  client: Browserbase
  browserbaseProjectId: string
  policy: BrowserbaseSessionMeteringPolicy
  env: Partial<Record<string, string | undefined>>
}) {
  const workerId = `browserbase-session-creation:${crypto.randomUUID()}`
  const claims = await supabaseServiceJson<Row[]>("rpc/claim_browser_provider_session_creation_reconciliation", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_worker_id: workerId,
      p_max_batch: BROWSERBASE_SESSION_METERING_RETRY_BATCH_SIZE,
      p_lease_seconds: 120,
    }),
  })
  let registered = 0
  let absent = 0
  let deferred = 0
  let escalated = 0

  for (const claim of claims) {
    const creationIntent = creationIntentFromClaim(claim)
    const priorAttemptCount = Number(claim.attempt_count ?? 0)
    let matches
    try {
      const sessions = await input.client.sessions.list({
        q: `user_metadata['mf_intent']:'${creationIntent.correlationToken}'`,
      })
      matches = sessions.filter((session) =>
        session.projectId === input.browserbaseProjectId
        && session.userMetadata?.mf_intent === creationIntent.correlationToken
      )
    } catch {
      const retry = await deferBrowserbaseSessionCreationOrThrow({
        browserbaseProjectId: input.browserbaseProjectId,
        creationIntentId: creationIntent.id,
        workerId,
        policy: input.policy,
        priorAttemptCount,
        errorCode: "provider_unavailable",
      })
      deferred += retry.permanent ? 0 : 1
      escalated += retry.permanent ? 1 : 0
      continue
    }

    if (matches.length === 0) {
      const retry = await deferBrowserbaseSessionCreationOrThrow({
        browserbaseProjectId: input.browserbaseProjectId,
        creationIntentId: creationIntent.id,
        workerId,
        policy: input.policy,
        priorAttemptCount,
        errorCode: "not_found",
      })
      absent += retry.resolvedAbsent ? 1 : 0
      deferred += retry.resolvedAbsent || retry.permanent ? 0 : 1
      escalated += retry.permanent ? 1 : 0
      continue
    }

    if (matches.length !== 1) {
      await Promise.allSettled(matches.map((session) =>
        requestBrowserbaseSessionReleaseIfStranded(input.client, session.id, input.browserbaseProjectId)
      ))
      const retry = await deferBrowserbaseSessionCreationOrThrow({
        browserbaseProjectId: input.browserbaseProjectId,
        creationIntentId: creationIntent.id,
        workerId,
        policy: input.policy,
        priorAttemptCount,
        errorCode: "multiple_matches",
      })
      deferred += retry.permanent ? 0 : 1
      escalated += retry.permanent ? 1 : 0
      continue
    }

    const match = matches[0]
    try {
      const registration = await registerBrowserbaseSessionForMetering({
        client: input.client,
        browserbaseProjectId: input.browserbaseProjectId,
        providerSessionId: match.id,
        creationIntent,
        env: input.env,
      })
      registered += 1
      let releaseError: unknown
      try {
        await requestBrowserbaseSessionReleaseIfStranded(input.client, match.id, input.browserbaseProjectId)
      } catch (error) {
        releaseError = error
      }
      await recordTerminalBrowserbaseSessionUsage({ client: input.client, registration, env: input.env })
      if (releaseError) throw releaseError
    } catch {
      // Registration compensates by stopping the provider session and keeping
      // the intent uncertain. If registration succeeded, terminal metering is
      // already durable and its independent retry queue owns recovery.
    }
  }
  return { claimed: claims.length, registered, absent, deferred, escalated }
}

async function deferBrowserbaseSessionCreationOrThrow(input: {
  browserbaseProjectId: string
  creationIntentId: string
  workerId: string
  policy: BrowserbaseSessionMeteringPolicy
  priorAttemptCount: number
  errorCode: "not_found" | "provider_unavailable" | "multiple_matches"
}) {
  const rows = await supabaseServiceJson<Row[]>("rpc/defer_browser_provider_session_creation_reconciliation", {
    method: "POST",
    body: JSON.stringify({
      p_creation_intent_id: input.creationIntentId,
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_worker_id: input.workerId,
      p_max_attempts: input.policy.maxAttempts,
      p_max_age_minutes: input.policy.maxAgeMinutes,
      p_retry_delay_seconds: browserbaseSessionMeteringRetryDelaySeconds(input.priorAttemptCount),
      p_error_code: input.errorCode,
      p_attempted_at: new Date().toISOString(),
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Browserbase session-creation reconciliation state was not persisted.")
  return {
    state: String(row.creation_state ?? ""),
    attemptCount: Number(row.attempt_count ?? input.priorAttemptCount + 1),
    resolvedAbsent: row.resolved_absent === true,
    permanent: row.permanent === true,
  }
}

function creationIntentFromClaim(row: Row): BrowserbaseSessionCreationIntent {
  const id = String(row.creation_intent_id ?? "")
  const correlationToken = String(row.correlation_token ?? "")
  if (!id || !/^[A-Za-z0-9_-]{22,64}$/.test(correlationToken)) {
    throw new Error("Browserbase session-creation queue returned an invalid durable intent.")
  }
  return { id, correlationToken, purpose: purposeFromMeteringClaim(row) }
}

async function reconcilePendingBrowserbaseSessionUsage(input: {
  client: Browserbase
  browserbaseProjectId: string
  policy: BrowserbaseSessionMeteringPolicy
}) {
  const workerId = `browserbase-session-metering:${crypto.randomUUID()}`
  const claims = await supabaseServiceJson<Row[]>("rpc/claim_browser_provider_session_metering", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.browserbaseProjectId),
      p_worker_id: workerId,
      p_max_batch: BROWSERBASE_SESSION_METERING_RETRY_BATCH_SIZE,
      p_lease_seconds: 120,
    }),
  })
  let resolved = 0
  let deferred = 0
  let escalated = 0
  for (const claim of claims) {
    const providerSessionId = String(claim.provider_session_id ?? "")
    const priorAttemptCount = Number(claim.attempt_count ?? 0)
    let poll
    try {
      poll = await pollBrowserbaseTerminalSession({
        retrieve: () => retrieveBrowserbaseSession(input.client, providerSessionId),
        expectedProjectId: input.browserbaseProjectId,
        delaysMs: [0],
      })
    } catch {
      const retry = await deferBrowserbaseSessionMeteringOrThrow({
        browserbaseProjectId: input.browserbaseProjectId,
        providerSessionId,
        workerId,
        policy: input.policy,
        priorAttemptCount,
        errorCode: "provider_unavailable",
        throwOnEscalation: false,
      })
      deferred += retry.escalated ? 0 : 1
      escalated += retry.escalated ? 1 : 0
      continue
    }
    if (poll.kind === "pending") {
      const retry = await deferBrowserbaseSessionMeteringOrThrow({
        browserbaseProjectId: input.browserbaseProjectId,
        providerSessionId,
        workerId,
        policy: input.policy,
        priorAttemptCount,
        errorCode: "not_terminal",
        throwOnEscalation: false,
      })
      deferred += retry.escalated ? 0 : 1
      escalated += retry.escalated ? 1 : 0
      continue
    }
    try {
      deriveBrowserbaseSessionUsage(poll.session, input.browserbaseProjectId)
    } catch {
      const retry = await deferBrowserbaseSessionMeteringOrThrow({
        browserbaseProjectId: input.browserbaseProjectId,
        providerSessionId,
        workerId,
        policy: input.policy,
        priorAttemptCount,
        errorCode: "invalid_terminal_record",
        throwOnEscalation: false,
      })
      deferred += retry.escalated ? 0 : 1
      escalated += retry.escalated ? 1 : 0
      continue
    }
    await persistTerminalBrowserbaseSessionUsage({
      browserbaseProjectId: input.browserbaseProjectId,
      providerSessionId,
      purpose: purposeFromMeteringClaim(claim),
      terminal: poll.session,
    })
    resolved += 1
  }
  return { claimed: claims.length, resolved, deferred, escalated }
}

function purposeFromMeteringClaim(row: Row): BrowserbaseUsagePurpose {
  if (row.purpose === "eval_run" && row.eval_run_id) {
    return { kind: "eval_run", evalRunId: String(row.eval_run_id) }
  }
  if (row.purpose === "page_scan" && row.agency_id && row.client_id) {
    return { kind: "page_scan", agencyId: String(row.agency_id), projectId: String(row.client_id) }
  }
  throw new Error("Browserbase session metering queue returned an invalid durable target.")
}

async function retrieveBrowserbaseSession(client: Browserbase, sessionId: string): Promise<BrowserbaseSessionUsageInput> {
  const session = await client.sessions.retrieve(sessionId)
  return {
    projectId: session.projectId,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? undefined,
    status: session.status,
    proxyBytes: session.proxyBytes,
  }
}

async function sampleProjectUsage(client: Browserbase, projectId: string) {
  const usage = await client.projects.usage(projectId)
  return { browserMinutes: usage.browserMinutes, proxyBytes: usage.proxyBytes }
}

async function claimBrowserbaseProjectUsageSample(input: {
  projectId: string
  workerId: string
  config: BrowserbaseCommercialGuardConfig
}) {
  const rows = await supabaseServiceJson<Row[]>("rpc/claim_browser_provider_project_usage_sample", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.projectId),
      p_worker_id: input.workerId,
      p_browser_minutes_limit: input.config.monthlyBrowserMinutesLimit,
      p_proxy_bytes_limit: input.config.monthlyProxyBytesLimit,
      p_warning_percent: input.config.warningPercent,
      p_lease_seconds: 45,
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Browserbase usage sampling did not return a lease state.")
  return { claimed: row.claimed === true, state: presentControlState(row) }
}

async function persistProjectUsage(input: {
  projectId: string
  usage: { browserMinutes: number; proxyBytes: number }
  config: BrowserbaseCommercialGuardConfig
  source: "session_preflight" | "daily_reconciliation"
  workerId: string
}) {
  const rows = await supabaseServiceJson<Row[]>("rpc/record_browser_provider_project_usage", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.projectId),
      p_browser_minutes: input.usage.browserMinutes,
      p_proxy_bytes: input.usage.proxyBytes,
      p_browser_minutes_limit: input.config.monthlyBrowserMinutesLimit,
      p_proxy_bytes_limit: input.config.monthlyProxyBytesLimit,
      p_warning_percent: input.config.warningPercent,
      p_source: input.source,
      p_worker_id: input.workerId,
      p_sampled_at: new Date().toISOString(),
    }),
  })
  if (!rows[0]) throw new Error("Browserbase usage control did not persist the provider sample.")
  return presentControlState(rows[0])
}

async function markBrowserbaseUsageControlFailure(input: {
  projectId: string
  config: BrowserbaseCommercialGuardConfig
  reason: string
  permanent: boolean
  workerId?: string
}) {
  await supabaseServiceJson("rpc/mark_browser_provider_usage_failure", {
    method: "POST",
    body: JSON.stringify({
      p_project_key: browserbaseProjectKey(input.projectId),
      p_browser_minutes_limit: input.config.monthlyBrowserMinutesLimit,
      p_proxy_bytes_limit: input.config.monthlyProxyBytesLimit,
      p_warning_percent: input.config.warningPercent,
      p_reason: input.reason,
      p_permanent: input.permanent,
      p_worker_id: input.workerId ?? null,
    }),
  })
}

function presentControlState(row: Row): BrowserbaseCostControlState {
  const status = String(row.control_status ?? row.status ?? "pending") as BrowserbaseCostControlState["status"]
  return {
    status,
    reason: String(row.control_reason ?? row.reason ?? ""),
    mayCreateSession: row.may_create_session === true,
    browserMinutes: Number(row.browser_minutes ?? 0),
    proxyBytes: Number(row.proxy_bytes ?? 0),
    sampledAt: row.sampled_at ? String(row.sampled_at) : null,
  }
}

function customerSafeUsageWarning(status: "healthy" | "warning" | "pending" | "paused") {
  if (status === "warning") return "Managed browser capacity is approaching its reviewed safety ceiling."
  if (status === "paused") return "New browser sessions are temporarily paused while provider usage is reconciled."
  if (status === "pending") return "Browser usage will appear after provider metering is connected."
  return ""
}
