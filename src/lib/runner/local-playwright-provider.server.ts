import "server-only"

import { chromium } from "playwright-core"
import type { Browser, BrowserContext } from "playwright-core"

import {
  BrowserContextRestoreError,
  sanitizeBrowserResumeUrl,
  waitForBrowserContextSynchronization,
} from "@/lib/runner/browser-context-policy"
import { executeWithConnectedBrowser } from "@/lib/runner/playwright-engine.server"
import type { BrowserEvalProvider, BrowserSessionHandle, ExecuteBrowserPhaseInput } from "@/lib/runner/types"

export class LocalPlaywrightProvider implements BrowserEvalProvider {
  readonly name = "local_playwright" as const

  async executePhase(input: ExecuteBrowserPhaseInput) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("The local Playwright provider is disabled in production.")
    }

    const state = resolveLocalContext(input)
    if (state.active) {
      throw new BrowserContextRestoreError("Another local browser phase is already using this Context.")
    }
    await waitForBrowserContextSynchronization(input.session?.readyAt ?? state.readyAt)
    state.active = true

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
    const lastSessionId = `local-session-${crypto.randomUUID()}`
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
      const context = await browser.newContext({
        serviceWorkers: "block",
        ...(state.storageState ? { storageState: state.storageState } : {}),
      })
      const page = await context.newPage()
      const session: BrowserSessionHandle = {
        provider: this.name,
        contextId: state.contextId,
        lastSessionId,
        resumeUrl: state.resumeUrl,
        readyAt: state.readyAt,
      }

      const phase = await executeWithConnectedBrowser(input, {
        browser,
        context,
        page,
        session,
        networkMode: "pinned_worker",
        resumeUrl: state.resumeUrl,
        beforeDisconnect: async () => {
          const resumeUrl = sanitizeBrowserResumeUrl(page.url(), input.allowedHosts)
          if (!resumeUrl) {
            throw new BrowserContextRestoreError("The local browser phase did not finish on an approved resumable page.")
          }
          state.storageState = await context.storageState()
          state.resumeUrl = resumeUrl
          state.lastSessionId = lastSessionId
          state.readyAt = new Date().toISOString()
        },
      })

      return {
        ...phase,
        session: handleFromLocalState(state),
      }
    } finally {
      // The provider owns browser teardown, including guard/resume failures,
      // so a local browser is never left running between durable phases.
      try {
        await browser?.close()
      } finally {
        state.active = false
      }
    }
  }

  async releaseRunContext(runId: string, session?: BrowserSessionHandle) {
    const contextId = session?.contextId ?? localRunContexts.get(runId)
    if (!contextId) return
    const state = localContextStates.get(contextId)
    if (state?.runId !== runId) {
      throw new BrowserContextRestoreError("The local Context does not belong to this eval run.")
    }
    localContextStates.delete(contextId)
    localRunContexts.delete(runId)
  }

  async loadRunContext(runId: string) {
    const contextId = localRunContexts.get(runId)
    const state = contextId ? localContextStates.get(contextId) : null
    return state ? handleFromLocalState(state) : null
  }
}

type LocalContextState = {
  runId: string
  contextId: string
  lastSessionId: string | null
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>
  resumeUrl: string | null
  readyAt: string
  active: boolean
}

const localContextStates = new Map<string, LocalContextState>()
const localRunContexts = new Map<string, string>()

function resolveLocalContext(input: ExecuteBrowserPhaseInput) {
  if (input.session) {
    if (input.session.provider !== "local_playwright") {
      throw new BrowserContextRestoreError("The durable Context belongs to a different browser provider.")
    }
    const state = localContextStates.get(input.session.contextId)
    if (!state || state.runId !== input.runId || localRunContexts.get(input.runId) !== state.contextId) {
      throw new BrowserContextRestoreError("The local browser state is no longer available; the phase was not replayed.")
    }
    if (state.resumeUrl !== input.session.resumeUrl || state.lastSessionId !== input.session.lastSessionId) {
      throw new BrowserContextRestoreError("The durable local Context handle is stale.")
    }
    return state
  }

  if (input.contextMode === "restore") {
    throw new BrowserContextRestoreError("A continuation phase cannot create a replacement Context.")
  }
  const existingContextId = localRunContexts.get(input.runId)
  if (existingContextId) {
    const existing = localContextStates.get(existingContextId)
    if (!existing) throw new BrowserContextRestoreError("The run's local browser state is missing.")
    return existing
  }

  const contextId = `local-context-${crypto.randomUUID()}`
  const state: LocalContextState = {
    runId: input.runId,
    contextId,
    lastSessionId: null,
    resumeUrl: null,
    readyAt: new Date().toISOString(),
    active: false,
  }
  localContextStates.set(contextId, state)
  localRunContexts.set(input.runId, contextId)
  return state
}

function handleFromLocalState(state: LocalContextState): BrowserSessionHandle {
  return {
    provider: "local_playwright",
    contextId: state.contextId,
    lastSessionId: state.lastSessionId,
    resumeUrl: state.resumeUrl,
    readyAt: state.readyAt,
  }
}
