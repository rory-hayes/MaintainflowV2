export type BrowserContextCleanupClaimRecord = {
  leaseId: string
  agencyId: string
  runId: string
  contextId: string
  lastSessionId: string | null
  cleanupAttempt: number
}

export type BrowserContextCleanupStore = {
  claim(input: { batchSize: number; workerId: string; leaseSeconds: number }): Promise<BrowserContextCleanupClaimRecord[]>
  finish(input: { leaseId: string; workerId: string }): Promise<unknown>
  retry(input: {
    leaseId: string
    workerId: string
    errorCode: string
    retryAfterSeconds: number
  }): Promise<unknown>
}

export type BrowserContextCleanupProvider = {
  releaseSession(sessionId: string): Promise<void>
  deleteContext(contextId: string): Promise<void>
}

export type BrowserContextCleanupBatchResult = {
  claimed: number
  deleted: number
  retryScheduled: number
  persistenceFailed: number
  results: Array<{
    leaseId: string
    runId: string
    cleanupAttempt: number
    status: "deleted" | "retry_scheduled" | "persistence_failed"
    errorCode?: string
  }>
}

export async function executeBrowserContextCleanupBatch(input: {
  store: BrowserContextCleanupStore
  provider: BrowserContextCleanupProvider
  batchSize: number
  workerId: string
  leaseSeconds: number
  maxConcurrency?: number
}): Promise<BrowserContextCleanupBatchResult> {
  const batchSize = bounded(input.batchSize, 1, 20)
  const leaseSeconds = bounded(input.leaseSeconds, 30, 900)
  const maxConcurrency = bounded(input.maxConcurrency ?? 4, 1, 4)
  const claims = await input.store.claim({ batchSize, workerId: input.workerId, leaseSeconds })

  let cursor = 0
  const results: BrowserContextCleanupBatchResult["results"] = []
  const workers = Array.from({ length: Math.min(maxConcurrency, claims.length) }, async () => {
    while (cursor < claims.length) {
      const claim = claims[cursor]
      cursor += 1
      if (!claim) continue
      results.push(await cleanClaim(input.store, input.provider, input.workerId, claim))
    }
  })
  await Promise.all(workers)

  return {
    claimed: claims.length,
    deleted: results.filter((result) => result.status === "deleted").length,
    retryScheduled: results.filter((result) => result.status === "retry_scheduled").length,
    persistenceFailed: results.filter((result) => result.status === "persistence_failed").length,
    results,
  }
}

export function browserContextCleanupRetrySeconds(cleanupAttempt: number) {
  const exponent = Math.max(0, Math.min(10, Math.trunc(cleanupAttempt) - 1))
  return Math.min(21_600, 30 * (2 ** exponent))
}

async function cleanClaim(
  store: BrowserContextCleanupStore,
  provider: BrowserContextCleanupProvider,
  workerId: string,
  claim: BrowserContextCleanupClaimRecord
) {
  let errorCode: string | null = null
  try {
    if (claim.lastSessionId) await provider.releaseSession(claim.lastSessionId)
  } catch (error) {
    if (!isMissingProviderResource(error)) errorCode = providerErrorCode(error, "SESSION_RELEASE_FAILED")
  }

  if (!errorCode) {
    try {
      await provider.deleteContext(claim.contextId)
    } catch (error) {
      if (!isMissingProviderResource(error)) errorCode = providerErrorCode(error, "CONTEXT_DELETE_FAILED")
    }
  }

  if (errorCode) {
    try {
      await store.retry({
        leaseId: claim.leaseId,
        workerId,
        errorCode,
        retryAfterSeconds: browserContextCleanupRetrySeconds(claim.cleanupAttempt),
      })
      return safeResult(claim, "retry_scheduled" as const, errorCode)
    } catch {
      return safeResult(claim, "persistence_failed" as const, "CLEANUP_RETRY_PERSIST_FAILED")
    }
  }

  try {
    await store.finish({ leaseId: claim.leaseId, workerId })
    return safeResult(claim, "deleted" as const)
  } catch {
    // The provider resource is already gone. Leave the short database claim
    // to expire; the next idempotent pass will observe provider 404 and finish.
    return safeResult(claim, "persistence_failed" as const, "CLEANUP_FINISH_PERSIST_FAILED")
  }
}

function safeResult(
  claim: BrowserContextCleanupClaimRecord,
  status: "deleted" | "retry_scheduled" | "persistence_failed",
  errorCode?: string
) {
  return {
    leaseId: claim.leaseId,
    runId: claim.runId,
    cleanupAttempt: claim.cleanupAttempt,
    status,
    ...(errorCode ? { errorCode } : {}),
  }
}

function providerErrorCode(error: unknown, fallback: string) {
  const status = providerStatus(error)
  if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED"
  if (status === 429) return "PROVIDER_RATE_LIMITED"
  if (status !== null && status >= 500) return "PROVIDER_UNAVAILABLE"
  return fallback
}

function isMissingProviderResource(error: unknown) {
  return providerStatus(error) === 404
}

function providerStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return null
  const candidate = error as { status?: unknown; statusCode?: unknown }
  const value = candidate.status ?? candidate.statusCode
  const status = Number(value)
  return Number.isInteger(status) ? status : null
}

function bounded(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value)) return minimum
  return Math.max(minimum, Math.min(value, maximum))
}
