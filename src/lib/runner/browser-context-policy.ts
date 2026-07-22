export const BROWSER_CONTEXT_RESTORE_ERROR_CODE = "BROWSER_CONTEXT_RESTORE_FAILED"
export const BROWSERBASE_CONTEXT_SYNC_DELAY_MS = 5_000
export const BROWSERBASE_CONTEXT_MAX_SYNC_WAIT_MS = 10_000

const safeHostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export class BrowserContextRestoreError extends Error {
  readonly code = BROWSER_CONTEXT_RESTORE_ERROR_CODE

  constructor(reason: string) {
    super(`${BROWSER_CONTEXT_RESTORE_ERROR_CODE}: ${reason}`)
    this.name = "BrowserContextRestoreError"
  }
}

export function isBrowserContextRestoreError(error: unknown) {
  return error instanceof BrowserContextRestoreError
    || (error instanceof Error && error.message.includes(BROWSER_CONTEXT_RESTORE_ERROR_CODE))
}

type BrowserbaseContextLeaseSnapshot = {
  contextId: string
  lastSessionId: string | null
  readyAt: string
}

type BrowserbaseContextWorkflowHandle = BrowserbaseContextLeaseSnapshot & {
  provider: string
}

export function resolveBrowserbaseContextReleaseTarget(
  lease: BrowserbaseContextLeaseSnapshot | null,
  session?: BrowserbaseContextWorkflowHandle
) {
  if (session && session.provider !== "browserbase") {
    throw new BrowserContextRestoreError("The durable Context belongs to a different browser provider.")
  }
  if (lease) {
    if (session && session.contextId !== lease.contextId) {
      throw new BrowserContextRestoreError("The private Context lease does not match the durable workflow handle.")
    }
    // The private lease is updated after every session teardown. A Workflow
    // handle can therefore be stale at finalization even when it still points
    // at the correct Context; never let it override the current release data.
    return {
      contextId: lease.contextId,
      lastSessionId: lease.lastSessionId,
      readyAt: lease.readyAt,
    }
  }
  return session
    ? {
        contextId: session.contextId,
        lastSessionId: session.lastSessionId,
        readyAt: session.readyAt,
      }
    : null
}

export async function reconcileAmbiguousBrowserbaseContextRegistration<T extends { contextId: string }>(input: {
  createdContextId: string
  registrationError: unknown
  loadWinner: () => Promise<T | null>
  deleteCreatedContext: () => Promise<void>
}) {
  let winner: T | null
  try {
    // A timed-out registration POST may still have committed. Reconcile the
    // authoritative durable lease before considering deletion.
    winner = await input.loadWinner()
  } catch {
    // Reconciliation itself is ambiguous. Preserve the registration failure
    // and leave the inactive Context intact rather than risk deleting the
    // Context that the database may already own.
    throw input.registrationError
  }

  if (winner) {
    if (winner.contextId !== input.createdContextId) {
      // Another durable attempt won the unique run lease, so this Context is
      // definitely the unused loser and can be deleted safely.
      await input.deleteCreatedContext()
    }
    return winner
  }

  // A successful authoritative read proved the registration did not commit.
  // Cleanup is best-effort here so the original registration failure remains
  // the actionable error if provider cleanup is temporarily unavailable.
  await input.deleteCreatedContext().catch(() => undefined)
  throw input.registrationError
}

export function requireBrowserbaseAllowedDomains(hosts: string[]) {
  const domains = [...new Set(hosts.map((host) => host.trim().toLowerCase()))]
  if (!domains.length || domains.length > 32) {
    throw new Error("A Browserbase session requires between 1 and 32 approved domains.")
  }
  for (const domain of domains) {
    if (!safeHostnamePattern.test(domain) || domain.includes("..")) {
      throw new Error("A Browserbase session received an invalid approved domain.")
    }
  }
  return domains
}

export function sanitizeBrowserResumeUrl(value: string, allowedDomains: string[]) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const covered = allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    if (url.protocol !== "https:" || !covered || url.username || url.password) return null
    return `${url.origin}${url.pathname || "/"}`
  } catch {
    return null
  }
}

export function browserContextSynchronizationWaitMs(readyAt: string, nowMs = Date.now()) {
  const readyAtMs = Date.parse(readyAt)
  if (!Number.isFinite(readyAtMs)) {
    throw new BrowserContextRestoreError("The Context readiness timestamp is invalid.")
  }
  const waitMs = Math.max(0, readyAtMs - nowMs)
  if (waitMs > BROWSERBASE_CONTEXT_MAX_SYNC_WAIT_MS) {
    throw new BrowserContextRestoreError("The Context readiness delay exceeded its bounded safety window.")
  }
  return waitMs
}

export async function waitForBrowserContextSynchronization(
  readyAt: string,
  options: { now?: () => number; wait?: (milliseconds: number) => Promise<void> } = {}
) {
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const waitMs = browserContextSynchronizationWaitMs(readyAt, now())
  if (waitMs > 0) await wait(waitMs)
}
