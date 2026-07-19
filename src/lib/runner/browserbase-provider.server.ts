import "server-only"

import Browserbase from "@browserbasehq/sdk"
import { chromium } from "playwright-core"

import { requireBrowserbaseExternalEgressProxy, type BrowserbaseExternalEgressProxy } from "@/lib/runner/browserbase-egress-config"
import { executeWithConnectedBrowser } from "@/lib/runner/playwright-engine.server"
import type { BrowserEvalProvider, BrowserSessionHandle, ExecuteBrowserPhaseInput } from "@/lib/runner/types"

export class BrowserbasePlaywrightProvider implements BrowserEvalProvider {
  readonly name = "browserbase" as const
  private readonly apiKey: string
  private readonly projectId: string
  private readonly externalEgressProxy: BrowserbaseExternalEgressProxy

  constructor(env: Partial<Record<string, string | undefined>> = process.env) {
    this.apiKey = env.BROWSERBASE_API_KEY?.trim() ?? ""
    this.projectId = env.BROWSERBASE_PROJECT_ID?.trim() ?? ""
    if (!this.apiKey) throw new Error("BROWSERBASE_API_KEY is required for the production browser provider.")
    this.externalEgressProxy = requireBrowserbaseExternalEgressProxy(env)
  }

  async executePhase(input: ExecuteBrowserPhaseInput) {
    const client = this.client()
    const created = input.session ? null : await this.createSession(client, input)
    const session = input.session ?? created?.session
    if (!session) throw new Error("Browserbase did not create a reconnectable session handle.")
    const current = input.session ? await client.sessions.retrieve(session.sessionId) : null
    const connectUrl = input.session ? current?.connectUrl : created?.connectUrl
    if (!connectUrl) throw new Error("The Browserbase session is no longer reconnectable.")

    const browser = await chromium.connectOverCDP(connectUrl).catch(() => {
      // Playwright connection errors can echo the signed WebSocket URL. Keep
      // that provider credential out of Workflow errors and application logs.
      throw new Error("The Browserbase session connection failed securely.")
    })
    const context = browser.contexts()[0]
    const page = context?.pages()[0]
    if (!context || !page) {
      await browser.close().catch(() => undefined)
      throw new Error("Browserbase did not expose its recorded default context.")
    }

    return executeWithConnectedBrowser(input, {
      browser,
      context,
      page,
      session,
      networkMode: "external_proxy",
    })
  }

  async releaseSession(session: BrowserSessionHandle) {
    await this.client().sessions.update(session.sessionId, { status: "REQUEST_RELEASE" })
  }

  private client() {
    return new Browserbase({ apiKey: this.apiKey, maxRetries: 1, timeout: 30_000 })
  }

  private async createSession(client: Browserbase, input: ExecuteBrowserPhaseInput): Promise<{ session: BrowserSessionHandle; connectUrl: string }> {
    const session = await client.sessions.create({
      ...(this.projectId ? { projectId: this.projectId } : {}),
      keepAlive: true,
      timeout: 3_600,
      // The single rule has no domainPattern, so Browserbase applies this
      // authenticated security proxy to every browser request. There is no
      // direct, `none`, or Browserbase-managed proxy fallback.
      proxies: [this.externalEgressProxy],
      region: "eu-central-1",
      browserSettings: {
        advancedStealth: false,
        solveCaptchas: false,
        ignoreCertificateErrors: false,
        recordSession: false,
        logSession: false,
      },
    }).catch(() => {
      // Provider validation errors may contain the submitted proxy object.
      // Never forward proxy origins or credentials into durable Workflow errors.
      throw new Error("Browserbase rejected the policy-constrained session configuration.")
    })

    return {
      connectUrl: session.connectUrl,
      session: {
        provider: this.name,
        sessionId: session.id,
        allowedHosts: input.allowedHosts,
        expiresAt: session.expiresAt,
      },
    }
  }
}
