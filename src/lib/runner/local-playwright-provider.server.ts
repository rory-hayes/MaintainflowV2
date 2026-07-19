import "server-only"

import { chromium } from "playwright-core"
import type { BrowserContext } from "playwright-core"

import { executeWithConnectedBrowser } from "@/lib/runner/playwright-engine.server"
import type { BrowserEvalProvider, BrowserSessionHandle, ExecuteBrowserPhaseInput } from "@/lib/runner/types"

export class LocalPlaywrightProvider implements BrowserEvalProvider {
  readonly name = "local_playwright" as const

  async executePhase(input: ExecuteBrowserPhaseInput) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("The local Playwright provider is disabled in production.")
    }

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
    const sessionId = input.session?.sessionId ?? `local-${crypto.randomUUID()}`
    const saved = input.session ? await loadLocalSessionState(sessionId) : null
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    const context = await browser.newContext({
      serviceWorkers: "block",
      ...(saved?.storageState ? { storageState: saved.storageState } : {}),
    })
    const page = await context.newPage()
    const session: BrowserSessionHandle = {
      provider: this.name,
      sessionId,
      allowedHosts: input.allowedHosts,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }

    return executeWithConnectedBrowser(input, {
      browser,
      context,
      page,
      session,
      networkMode: "pinned_worker",
      resumeUrl: saved?.resumeUrl ?? null,
      beforeDisconnect: async () => {
        await saveLocalSessionState(sessionId, {
          storageState: await context.storageState(),
          resumeUrl: safeResumeUrl(page.url(), input.allowedHosts),
        })
      },
    })
  }

  async releaseSession(session: BrowserSessionHandle) {
    localSessionStates.delete(session.sessionId)
  }
}

type LocalSessionState = {
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>
  resumeUrl: string | null
}

const localSessionStates = new Map<string, LocalSessionState>()

async function loadLocalSessionState(sessionId: string): Promise<LocalSessionState | null> {
  return localSessionStates.get(sessionId) ?? null
}

async function saveLocalSessionState(sessionId: string, state: LocalSessionState) {
  localSessionStates.set(sessionId, state)
}

function safeResumeUrl(value: string, allowedHosts: string[]) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== "https:" || !allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}
