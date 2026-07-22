import "server-only"

import {
  claimBrowserContextCleanupBatch,
  finishBrowserContextCleanup,
  retryBrowserContextCleanup,
} from "@/lib/runner/browser-context-leases.server"
import {
  executeBrowserContextCleanupBatch,
  type BrowserContextCleanupProvider,
} from "@/lib/runner/browser-context-cleanup"

export async function runBrowserContextCleanupJanitor(input: {
  provider: BrowserContextCleanupProvider
  batchSize?: number
  leaseSeconds?: number
  maxConcurrency?: number
  workerId?: string
}) {
  const workerId = input.workerId ?? `context-cleanup:${crypto.randomUUID()}`
  return executeBrowserContextCleanupBatch({
    store: {
      claim: claimBrowserContextCleanupBatch,
      finish: finishBrowserContextCleanup,
      retry: retryBrowserContextCleanup,
    },
    provider: input.provider,
    batchSize: input.batchSize ?? 10,
    workerId,
    leaseSeconds: input.leaseSeconds ?? 120,
    maxConcurrency: input.maxConcurrency,
  })
}
