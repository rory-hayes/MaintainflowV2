import "server-only"

import { supabaseServiceJson } from "@/lib/supabase/server"

type BrowserContextLeaseRow = {
  id: string
  agency_id: string
  eval_run_id: string
  context_id: string
  last_session_id: string
  resume_url: string
  sync_ready_at: string | null
  delete_after: string
  session_lease_expires_at: string | null
  cleanup_status: BrowserContextCleanupStatus
  cleanup_requested_at: string | null
  cleanup_attempts: number
  cleanup_lease_expires_at: string | null
  next_cleanup_at: string | null
  last_cleanup_error_code: string
  released_at: string | null
  created_at: string
  updated_at: string
}

type BrowserContextSessionClaimRow = {
  may_execute: boolean
  retry_after_at: string | null
  lease_expires_at: string | null
}

type BrowserContextCleanupClaimRow = {
  lease_id: string
  agency_id: string
  eval_run_id: string
  context_id: string
  last_session_id: string
  cleanup_attempt: number
}

export type BrowserContextCleanupStatus = "active" | "pending" | "claimed" | "deleted" | "failed"

export type BrowserContextLease = {
  id: string
  agencyId: string
  runId: string
  contextId: string
  lastSessionId: string | null
  resumeUrl: string | null
  readyAt: string
  syncReadyAt: string | null
  deleteAfter: string
  sessionLeaseExpiresAt: string | null
  cleanupStatus: BrowserContextCleanupStatus
  cleanupRequestedAt: string | null
  cleanupAttempts: number
  cleanupLeaseExpiresAt: string | null
  nextCleanupAt: string | null
  lastCleanupErrorCode: string | null
  releasedAt: string | null
  createdAt: string
  updatedAt: string
}

export type BrowserContextCleanupClaim = {
  leaseId: string
  agencyId: string
  runId: string
  contextId: string
  lastSessionId: string | null
  cleanupAttempt: number
}

export async function loadBrowserContextLeaseForRun(runId: string) {
  assertUuid(runId, "eval run ID")
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>(
    `browser_context_leases?${new URLSearchParams({
      eval_run_id: `eq.${runId}`,
      select: [
        "id", "agency_id", "eval_run_id", "context_id", "last_session_id", "resume_url",
        "sync_ready_at", "delete_after", "session_lease_expires_at", "cleanup_status",
        "cleanup_requested_at", "cleanup_attempts",
        "cleanup_lease_expires_at", "next_cleanup_at", "last_cleanup_error_code",
        "released_at", "created_at", "updated_at",
      ].join(","),
      limit: "1",
    }).toString()}`
  )
  return rows[0] ? mapLease(rows[0]) : null
}

export async function registerBrowserContextLease(input: {
  runId: string
  contextId: string
  deleteAfter: string
}) {
  assertUuid(input.runId, "eval run ID")
  assertOpaqueProviderId(input.contextId, "Context ID")
  const deleteAfter = normalizeRequiredTimestamp(input.deleteAfter, "Context deletion deadline")
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>("rpc/register_browser_context_lease", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: input.runId,
      p_context_id: input.contextId,
      p_delete_after: deleteAfter,
    }),
  })
  return requireLease(rows, "The Browser Context lease was not registered.")
}

export async function acquireBrowserContextSession(input: {
  runId: string
  contextId: string
  ownerToken: string
  leaseSeconds: number
}) {
  assertUuid(input.runId, "eval run ID")
  assertOpaqueProviderId(input.contextId, "Context ID")
  assertUuid(input.ownerToken, "session owner token")
  const rows = await supabaseServiceJson<BrowserContextSessionClaimRow[]>("rpc/claim_browser_context_session", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: input.runId,
      p_context_id: input.contextId,
      p_owner_token: input.ownerToken,
      p_lease_seconds: boundedInteger(input.leaseSeconds, 30, 3_600, "session lease seconds"),
    }),
  })
  const claim = rows[0]
  if (!claim) throw new Error("The Browser Context session claim returned no result.")
  return {
    mayExecute: claim.may_execute === true,
    retryAfterAt: normalizeNullableTimestamp(claim.retry_after_at, "Context session retry time"),
    leaseExpiresAt: normalizeNullableTimestamp(claim.lease_expires_at, "Context session lease expiry"),
  }
}

export async function recordBrowserContextSessionStarted(input: {
  runId: string
  contextId: string
  ownerToken: string
  lastSessionId: string
}) {
  assertSessionInput(input)
  assertOpaqueProviderId(input.lastSessionId, "Browser session ID")
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>("rpc/record_browser_context_session_started", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: input.runId,
      p_context_id: input.contextId,
      p_owner_token: input.ownerToken,
      p_last_session_id: input.lastSessionId,
    }),
  })
  return requireLease(rows, "The Browser Context session start was not recorded.")
}

export async function completeBrowserContextSession(input: {
  runId: string
  contextId: string
  ownerToken: string
  lastSessionId: string | null
  resumeUrl: string | null
  readyAt: string
}) {
  assertSessionInput(input)
  if (input.lastSessionId) assertOpaqueProviderId(input.lastSessionId, "Browser session ID")
  const readyAt = normalizeRequiredTimestamp(input.readyAt, "Context synchronization time")
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>("rpc/complete_browser_context_session", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: input.runId,
      p_context_id: input.contextId,
      p_owner_token: input.ownerToken,
      p_last_session_id: input.lastSessionId ?? "",
      p_resume_url: input.resumeUrl ?? "",
      p_sync_ready_at: readyAt,
    }),
  })
  return requireLease(rows, "The Browser Context session completion was not recorded.")
}

export async function releaseBrowserContextLease(input: {
  runId: string
  contextId: string
}) {
  assertUuid(input.runId, "eval run ID")
  assertOpaqueProviderId(input.contextId, "Context ID")
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>("rpc/mark_browser_context_released", {
    method: "POST",
    body: JSON.stringify({
      p_eval_run_id: input.runId,
      p_context_id: input.contextId,
      p_reason_code: "RUN_TERMINAL",
    }),
  })
  return requireLease(rows, "The Browser Context release was not recorded.")
}

export async function claimBrowserContextCleanupBatch(input: {
  batchSize: number
  workerId: string
  leaseSeconds: number
}) {
  assertWorkerId(input.workerId)
  const rows = await supabaseServiceJson<BrowserContextCleanupClaimRow[]>("rpc/claim_browser_context_cleanup_batch", {
    method: "POST",
    body: JSON.stringify({
      p_limit: boundedInteger(input.batchSize, 1, 20, "cleanup batch size"),
      p_worker_id: input.workerId,
      p_lease_seconds: boundedInteger(input.leaseSeconds, 30, 900, "cleanup lease seconds"),
    }),
  })
  return rows.map(mapCleanupClaim)
}

export async function finishBrowserContextCleanup(input: { leaseId: string; workerId: string }) {
  assertUuid(input.leaseId, "Context lease ID")
  assertWorkerId(input.workerId)
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>("rpc/complete_browser_context_cleanup", {
    method: "POST",
    body: JSON.stringify({ p_lease_id: input.leaseId, p_worker_id: input.workerId }),
  })
  return requireLease(rows, "The Browser Context cleanup completion was not recorded.")
}

export async function retryBrowserContextCleanup(input: {
  leaseId: string
  workerId: string
  errorCode: string
  retryAfterSeconds: number
}) {
  assertUuid(input.leaseId, "Context lease ID")
  assertWorkerId(input.workerId)
  if (!/^[A-Z0-9_]{3,64}$/.test(input.errorCode)) throw new Error("Context cleanup error code is invalid.")
  const rows = await supabaseServiceJson<BrowserContextLeaseRow[]>("rpc/retry_browser_context_cleanup", {
    method: "POST",
    body: JSON.stringify({
      p_lease_id: input.leaseId,
      p_worker_id: input.workerId,
      p_error_code: input.errorCode,
      p_retry_after_seconds: boundedInteger(input.retryAfterSeconds, 30, 21_600, "cleanup retry seconds"),
    }),
  })
  return requireLease(rows, "The Browser Context cleanup retry was not recorded.")
}

function mapLease(row: BrowserContextLeaseRow): BrowserContextLease {
  const createdAt = normalizeRequiredTimestamp(row.created_at, "Context lease creation time")
  const syncReadyAt = normalizeNullableTimestamp(row.sync_ready_at, "Context synchronization time")
  return {
    id: row.id,
    agencyId: row.agency_id,
    runId: row.eval_run_id,
    contextId: row.context_id,
    lastSessionId: emptyToNull(row.last_session_id),
    resumeUrl: emptyToNull(row.resume_url),
    readyAt: syncReadyAt ?? createdAt,
    syncReadyAt,
    deleteAfter: normalizeRequiredTimestamp(row.delete_after, "Context deletion deadline"),
    sessionLeaseExpiresAt: normalizeNullableTimestamp(row.session_lease_expires_at, "Context session lease expiry"),
    cleanupStatus: row.cleanup_status,
    cleanupRequestedAt: normalizeNullableTimestamp(row.cleanup_requested_at, "Context cleanup request time"),
    cleanupAttempts: row.cleanup_attempts,
    cleanupLeaseExpiresAt: normalizeNullableTimestamp(row.cleanup_lease_expires_at, "Context cleanup lease expiry"),
    nextCleanupAt: normalizeNullableTimestamp(row.next_cleanup_at, "Context next cleanup time"),
    lastCleanupErrorCode: emptyToNull(row.last_cleanup_error_code),
    releasedAt: normalizeNullableTimestamp(row.released_at, "Context release time"),
    createdAt,
    updatedAt: normalizeRequiredTimestamp(row.updated_at, "Context lease update time"),
  }
}

function mapCleanupClaim(row: BrowserContextCleanupClaimRow): BrowserContextCleanupClaim {
  return {
    leaseId: row.lease_id,
    agencyId: row.agency_id,
    runId: row.eval_run_id,
    contextId: row.context_id,
    lastSessionId: emptyToNull(row.last_session_id),
    cleanupAttempt: row.cleanup_attempt,
  }
}

function requireLease(rows: BrowserContextLeaseRow[], message: string) {
  if (!rows[0]) throw new Error(message)
  return mapLease(rows[0])
}

function assertSessionInput(input: { runId: string; contextId: string; ownerToken: string }) {
  assertUuid(input.runId, "eval run ID")
  assertOpaqueProviderId(input.contextId, "Context ID")
  assertUuid(input.ownerToken, "session owner token")
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
}

function assertOpaqueProviderId(value: string, label: string) {
  if (value.length < 8 || value.length > 255 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
}

function assertWorkerId(value: string) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(value)) throw new Error("Context cleanup worker ID is invalid.")
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid.`)
  return value
}

function normalizeRequiredTimestamp(value: string, label: string) {
  const normalized = normalizeNullableTimestamp(value, label)
  if (!normalized) throw new Error(`${label} is invalid.`)
  return normalized
}

function normalizeNullableTimestamp(value: string | null, label: string) {
  if (value === null) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`)
  return new Date(milliseconds).toISOString()
}

function emptyToNull(value: string) {
  return value === "" ? null : value
}
