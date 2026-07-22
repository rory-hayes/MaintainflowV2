import "server-only"

import Browserbase from "@browserbasehq/sdk"

import { runBrowserContextCleanupJanitor } from "@/lib/runner/browser-context-cleanup.server"
import { requireBrowserbaseProjectId } from "@/lib/runner/browserbase-egress-config"
import {
  deleteBrowserbaseContext,
  requestBrowserbaseSessionReleaseIfStranded,
} from "@/lib/runner/browserbase-lifecycle.server"

export const BROWSERBASE_CONTEXT_CLEANUP_DEFAULT_BATCH_SIZE = 4
export const BROWSERBASE_CONTEXT_CLEANUP_MAX_BATCH_SIZE = 4
export const BROWSERBASE_CONTEXT_CLEANUP_PROVIDER_TIMEOUT_MS = 5_000
export const BROWSERBASE_CONTEXT_CLEANUP_PROVIDER_MAX_RETRIES = 0

export function boundedBrowserbaseContextCleanupBatchSize(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return BROWSERBASE_CONTEXT_CLEANUP_DEFAULT_BATCH_SIZE
  return Math.max(1, Math.min(Math.floor(parsed), BROWSERBASE_CONTEXT_CLEANUP_MAX_BATCH_SIZE))
}

export async function runBrowserbaseContextCleanupJanitor(input: {
  batchSize?: number
  workerId?: string
} = {}) {
  let client: Browserbase | null = null
  let projectId: string | null = null
  const getProjectId = () => {
    projectId ??= requireBrowserbaseProjectId(process.env)
    return projectId
  }
  const getClient = () => {
    if (client) return client
    const apiKey = process.env.BROWSERBASE_API_KEY?.trim() ?? ""
    if (!apiKey) throw new Error("Browserbase Context cleanup is not configured.")
    client = new Browserbase({
      apiKey,
      maxRetries: BROWSERBASE_CONTEXT_CLEANUP_PROVIDER_MAX_RETRIES,
      timeout: BROWSERBASE_CONTEXT_CLEANUP_PROVIDER_TIMEOUT_MS,
    })
    return client
  }

  return runBrowserContextCleanupJanitor({
    batchSize: boundedBrowserbaseContextCleanupBatchSize(input.batchSize),
    workerId: input.workerId,
    leaseSeconds: 120,
    maxConcurrency: 4,
    provider: {
      releaseSession: (sessionId) => requestBrowserbaseSessionReleaseIfStranded(getClient(), sessionId, getProjectId()),
      deleteContext: (contextId) => deleteBrowserbaseContext(getClient(), contextId, getProjectId()),
    },
  })
}
