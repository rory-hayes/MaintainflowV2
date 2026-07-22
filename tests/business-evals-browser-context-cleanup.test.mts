import assert from "node:assert/strict"
import test from "node:test"

import {
  browserContextCleanupRetrySeconds,
  executeBrowserContextCleanupBatch,
  type BrowserContextCleanupClaimRecord,
} from "../src/lib/runner/browser-context-cleanup.ts"

const claims: BrowserContextCleanupClaimRecord[] = [
  {
    leaseId: "10000000-0000-4000-8000-000000000001",
    agencyId: "20000000-0000-4000-8000-000000000001",
    runId: "30000000-0000-4000-8000-000000000001",
    contextId: "context-success",
    lastSessionId: "session-success",
    cleanupAttempt: 1,
  },
  {
    leaseId: "10000000-0000-4000-8000-000000000002",
    agencyId: "20000000-0000-4000-8000-000000000001",
    runId: "30000000-0000-4000-8000-000000000002",
    contextId: "context-rate-limit",
    lastSessionId: null,
    cleanupAttempt: 4,
  },
]

test("Browser Context cleanup retries forever with capped backoff but bounds each worker wave", async () => {
  const finished: string[] = []
  const retried: Array<{ leaseId: string; retryAfterSeconds: number; errorCode: string }> = []
  let claimedBatchSize = 0
  const result = await executeBrowserContextCleanupBatch({
    batchSize: 200,
    leaseSeconds: 120,
    maxConcurrency: 20,
    workerId: "context-cleanup:test",
    store: {
      claim: async ({ batchSize }) => {
        claimedBatchSize = batchSize
        return claims
      },
      finish: async ({ leaseId }) => { finished.push(leaseId) },
      retry: async ({ leaseId, retryAfterSeconds, errorCode }) => {
        retried.push({ leaseId, retryAfterSeconds, errorCode })
      },
    },
    provider: {
      releaseSession: async () => undefined,
      deleteContext: async (contextId) => {
        if (contextId === "context-rate-limit") throw Object.assign(new Error("private provider detail"), { status: 429 })
      },
    },
  })

  assert.equal(claimedBatchSize, 20)
  assert.deepEqual(finished, [claims[0].leaseId])
  assert.deepEqual(retried, [{
    leaseId: claims[1].leaseId,
    retryAfterSeconds: 240,
    errorCode: "PROVIDER_RATE_LIMITED",
  }])
  assert.equal(result.deleted, 1)
  assert.equal(result.retryScheduled, 1)
  assert.doesNotMatch(JSON.stringify(result), /context-success|context-rate-limit|session-success|private provider detail/)
  assert.equal(browserContextCleanupRetrySeconds(100), 21_600)
})

test("a stranded session must be released before its Context is deleted", async () => {
  let contextDeleteCalled = false
  const result = await executeBrowserContextCleanupBatch({
    batchSize: 1,
    leaseSeconds: 60,
    workerId: "context-cleanup:test",
    store: {
      claim: async () => [claims[0]],
      finish: async () => undefined,
      retry: async () => undefined,
    },
    provider: {
      releaseSession: async () => { throw Object.assign(new Error("unavailable"), { status: 503 }) },
      deleteContext: async () => { contextDeleteCalled = true },
    },
  })

  assert.equal(contextDeleteCalled, false)
  assert.equal(result.results[0]?.status, "retry_scheduled")
  assert.equal(result.results[0]?.errorCode, "PROVIDER_UNAVAILABLE")
})
