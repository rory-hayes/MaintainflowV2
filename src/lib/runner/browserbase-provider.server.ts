import "server-only"

import Browserbase from "@browserbasehq/sdk"
import { chromium } from "playwright-core"
import type { Browser } from "playwright-core"

import {
  acquireBrowserContextSession,
  completeBrowserContextSession,
  loadBrowserContextLeaseForRun,
  recordBrowserContextSessionStarted,
  registerBrowserContextLease,
  releaseBrowserContextLease,
} from "@/lib/runner/browser-context-leases.server"
import {
  BROWSERBASE_CONTEXT_SYNC_DELAY_MS,
  BrowserContextRestoreError,
  reconcileAmbiguousBrowserbaseContextRegistration,
  requireBrowserbaseAllowedDomains,
  resolveBrowserbaseContextReleaseTarget,
  sanitizeBrowserResumeUrl,
  waitForBrowserContextSynchronization,
} from "@/lib/runner/browser-context-policy"
import {
  requireBrowserbaseExternalEgressConfiguration,
  requireBrowserbaseProjectId,
} from "@/lib/runner/browserbase-egress-config"
import {
  deleteBrowserbaseContext,
  requestBrowserbaseSessionReleaseIfStranded,
} from "@/lib/runner/browserbase-lifecycle.server"
import {
  assertBrowserbaseSessionCommerciallyAllowed,
  markBrowserbaseSessionCreationUncertain,
  prepareBrowserbaseSessionCreation,
  recordTerminalBrowserbaseSessionUsage,
  registerBrowserbaseSessionForMetering,
  type BrowserbaseSessionMeteringRegistration,
} from "@/lib/runner/browserbase-usage-control.server"
import { issueBrowserProxyCredentials } from "@/lib/runner/browser-proxy-credentials.server"
import { executeWithConnectedBrowser } from "@/lib/runner/playwright-engine.server"
import type { BrowserEvalProvider, BrowserPhaseResult, BrowserSessionHandle, ExecuteBrowserPhaseInput } from "@/lib/runner/types"

const CONTEXT_DELETE_AFTER_MS = 4 * 60 * 60_000
const SESSION_LEASE_SECONDS = 10 * 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class BrowserbasePlaywrightProvider implements BrowserEvalProvider {
  readonly name = "browserbase" as const
  private readonly apiKey: string
  private readonly projectId: string
  private readonly env: Partial<Record<string, string | undefined>>

  constructor(env: Partial<Record<string, string | undefined>> = process.env) {
    this.env = env
    this.apiKey = env.BROWSERBASE_API_KEY?.trim() ?? ""
    this.projectId = requireBrowserbaseProjectId(env)
    if (!this.apiKey) throw new Error("BROWSERBASE_API_KEY is required for the production browser provider.")
  }

  async executePhase(input: ExecuteBrowserPhaseInput): Promise<BrowserPhaseResult> {
    const client = this.client()
    const allowedDomains = requireBrowserbaseAllowedDomains(input.allowedHosts)
    const session = await this.resolveContext(client, input)
    if (input.contextMode === "restore" && !session.resumeUrl) {
      throw new BrowserContextRestoreError("The prior phase did not persist an approved resumable location; no earlier action was replayed.")
    }

    await waitForBrowserContextSynchronization(session.readyAt)
    await this.requireContext(client, session.contextId)

    const ownerToken = crypto.randomUUID()
    let acquired = await acquireBrowserContextSession({
      runId: input.runId,
      contextId: session.contextId,
      ownerToken,
      leaseSeconds: SESSION_LEASE_SECONDS,
    })
    if (!acquired.mayExecute && acquired.retryAfterAt) {
      await waitForBrowserContextSynchronization(acquired.retryAfterAt)
      acquired = await acquireBrowserContextSession({
        runId: input.runId,
        contextId: session.contextId,
        ownerToken,
        leaseSeconds: SESSION_LEASE_SECONDS,
      })
    }
    if (!acquired.mayExecute) {
      throw new BrowserContextRestoreError("Another browser phase owns this Context; concurrent reuse was refused.")
    }

    let browser: Browser | undefined
    let lastSessionId: string | null = null
    let meteringRegistration: BrowserbaseSessionMeteringRegistration | null = null
    let phase: BrowserPhaseResult | undefined
    let resumeUrl = session.resumeUrl
    let readyAt: string | null = null
    let primaryError: unknown
    let hasPrimaryError = false
    try {
      // Mint at the session boundary: each phase receives a new jti while the
      // stable, non-secret subject keeps gateway policy attributable to this
      // run without putting a raw run ID in Browserbase metadata or logs.
      const proxyCredentials = issueBrowserProxyCredentials({
        subject: browserProxySubjectForRun(input.runId),
        sideEffectHosts: allowedDomains,
        env: this.env,
      })
      const externalEgress = requireBrowserbaseExternalEgressConfiguration(proxyCredentials, this.env)
      // The provider's own Project Usage API is the commercial boundary. If
      // Browserbase cannot return current browserMinutes and proxyBytes, or a
      // reviewed ceiling has been reached, fail before sessions.create().
      await assertBrowserbaseSessionCommerciallyAllowed({
        client,
        projectId: this.projectId,
        env: this.env,
      })
      const purpose = { kind: "eval_run" as const, evalRunId: input.runId }
      const creationIntent = await prepareBrowserbaseSessionCreation({
        browserbaseProjectId: this.projectId,
        purpose,
      })
      let created
      try {
        created = await client.sessions.create({
          projectId: this.projectId,
          keepAlive: false,
          timeout: 300,
          // The opaque token contains no tenant or run identifier. It is the
          // only provider metadata and lets a later worker reconcile a lost
          // create response without replaying this non-idempotent mutation.
          userMetadata: { mf_intent: creationIntent.correlationToken },
          // Browserbase allowedDomains protects approved main-frame navigation.
          // The authenticated catch-all proxy remains the egress boundary for
          // subresources, frames, workers, WebSockets, redirects, and DNS.
          proxies: externalEgress.proxies,
          proxySettings: externalEgress.proxySettings,
          region: "eu-central-1",
          browserSettings: {
            allowedDomains,
            context: { id: session.contextId, persist: true },
            advancedStealth: false,
            solveCaptchas: false,
            ignoreCertificateErrors: false,
            recordSession: false,
            logSession: false,
          },
        })
      } catch {
        await markBrowserbaseSessionCreationUncertain({
          browserbaseProjectId: this.projectId,
          creationIntentId: creationIntent.id,
          reason: "create_response_ambiguous",
        }).catch(() => undefined)
        // Provider validation errors may echo proxy configuration. Never put
        // provider payloads or connection credentials in durable step errors.
        throw new Error("Browserbase rejected or ambiguously answered the policy-constrained Context session configuration.")
      }
      lastSessionId = created.id
      meteringRegistration = await registerBrowserbaseSessionForMetering({
        client,
        browserbaseProjectId: this.projectId,
        providerSessionId: created.id,
        creationIntent,
        env: this.env,
      })
      if (created.contextId && created.contextId !== session.contextId) {
        throw new BrowserContextRestoreError("Browserbase attached a different Context than the run-scoped Context.")
      }
      await recordBrowserContextSessionStarted({
        runId: input.runId,
        contextId: session.contextId,
        ownerToken,
        lastSessionId,
      })

      browser = await chromium.connectOverCDP(created.connectUrl).catch(() => {
        // The signed WebSocket URL is a provider credential and must never be
        // copied into a Workflow error, log, lease record, or run summary.
        throw new Error("The Browserbase Context session connection failed securely.")
      })
      const context = browser.contexts()[0]
      const page = context?.pages()[0]
      if (!context || !page) {
        throw new BrowserContextRestoreError("Browserbase did not expose the persisted Context to the short-lived session.")
      }

      phase = await executeWithConnectedBrowser(input, {
        browser,
        context,
        page,
        session: { ...session, lastSessionId },
        networkMode: "external_proxy",
        resumeUrl: session.resumeUrl,
      })
      resumeUrl = sanitizeBrowserResumeUrl(phase.currentUrl, allowedDomains)
    } catch (error) {
      primaryError = error
      hasPrimaryError = true
    } finally {
      // The provider owns disconnect so a phase cannot return into an email
      // wait with a live browser. This also covers guard/resume setup failures;
      // with keepAlive:false, disconnecting ends the session.
      let disconnectFailed = Boolean(lastSessionId && !browser)
      if (browser) {
        try {
          await browser.close()
        } catch {
          disconnectFailed = true
        }
      }

      let releaseError: unknown
      let meteringError: unknown
      if (lastSessionId) {
        try {
          await requestBrowserbaseSessionReleaseIfStranded(client, lastSessionId, this.projectId)
        } catch (error) {
          // A successful disconnect is terminal because keepAlive is false.
          // Request-release is a stranded-session backstop; it becomes fatal
          // only when the CDP disconnect itself could not be completed.
          if (disconnectFailed) releaseError = error
        }
        try {
          if (!meteringRegistration) throw new Error("The Browserbase session has no durable metering registration.")
          await recordTerminalBrowserbaseSessionUsage({
            client,
            registration: meteringRegistration,
            env: this.env,
          })
        } catch (error) {
          meteringError = error
        }
      } else if (disconnectFailed) {
        releaseError = new Error("The short-lived browser session could not be ended securely.")
      }
      // Context synchronization starts only after browser disconnect and the
      // stranded-session release backstop have completed. The durable lease
      // and returned Workflow handle must share this post-shutdown timestamp.
      readyAt = new Date(Date.now() + BROWSERBASE_CONTEXT_SYNC_DELAY_MS).toISOString()
      if (!releaseError) {
        try {
          await completeBrowserContextSession({
            runId: input.runId,
            contextId: session.contextId,
            ownerToken,
            // Track the newest provider session whenever one was created. It
            // remains the authoritative stranded-session cleanup target even
            // when the phase itself failed before returning a Workflow handle.
            lastSessionId: lastSessionId ?? session.lastSessionId,
            resumeUrl,
            readyAt,
          })
        } catch (error) {
          if (!hasPrimaryError) {
            primaryError = error
            hasPrimaryError = true
          }
        }
      }
      if (!hasPrimaryError && releaseError) {
        primaryError = releaseError
        hasPrimaryError = true
      }
      if (!hasPrimaryError && meteringError) {
        primaryError = meteringError
        hasPrimaryError = true
      }
    }

    if (hasPrimaryError) throw primaryError
    if (!phase || !readyAt) {
      throw new Error("The Browserbase phase did not produce a durable result.")
    }
    return {
      ...phase,
      session: {
        provider: this.name,
        contextId: session.contextId,
        lastSessionId,
        resumeUrl,
        readyAt,
      },
    }
  }

  async releaseRunContext(runId: string, session?: BrowserSessionHandle) {
    const client = this.client()
    const lease = await loadBrowserContextLeaseForRun(runId)
    const target = resolveBrowserbaseContextReleaseTarget(lease, session)
    if (!target) return

    await waitForBrowserContextSynchronization(target.readyAt)
    // A disconnected keepAlive:false session should already be terminal. If a
    // provider-side session is still stranded, request release before deleting
    // the run-scoped Context so no browser can outlive finalization.
    if (target.lastSessionId) {
      await requestBrowserbaseSessionReleaseIfStranded(client, target.lastSessionId, this.projectId)
    }
    await deleteBrowserbaseContext(client, target.contextId, this.projectId)
    await releaseBrowserContextLease({ runId, contextId: target.contextId })
  }

  async loadRunContext(runId: string) {
    const lease = await loadBrowserContextLeaseForRun(runId)
    return lease && lease.cleanupStatus !== "deleted" ? handleFromLease(lease) : null
  }

  private client() {
    // Context and Session creation are non-idempotent provider mutations. A
    // transport timeout must be reconciled explicitly, never SDK-replayed.
    return new Browserbase({ apiKey: this.apiKey, maxRetries: 0, timeout: 30_000 })
  }

  private async resolveContext(client: Browserbase, input: ExecuteBrowserPhaseInput): Promise<BrowserSessionHandle> {
    const lease = await loadBrowserContextLeaseForRun(input.runId)
    if (input.session) {
      if (input.session.provider !== this.name) {
        throw new BrowserContextRestoreError("The durable Context belongs to a different browser provider.")
      }
      if (!lease || lease.contextId !== input.session.contextId) {
        throw new BrowserContextRestoreError("The private Context lease is missing or does not match; no replacement Context was created.")
      }
      if (
        lease.lastSessionId !== input.session.lastSessionId
        || lease.resumeUrl !== input.session.resumeUrl
        || lease.readyAt !== input.session.readyAt
      ) {
        throw new BrowserContextRestoreError("The durable Context handle is stale; the continuation was refused.")
      }
      return handleFromLease(lease)
    }

    if (input.contextMode === "restore") {
      throw new BrowserContextRestoreError("A continuation phase cannot create a replacement Context.")
    }
    if (lease) return handleFromLease(lease)

    const created = await client.contexts.create({ projectId: this.projectId }).catch(() => {
      throw new Error("Browserbase could not create the run-scoped Context securely.")
    })
    try {
      const registered = await registerBrowserContextLease({
        runId: input.runId,
        contextId: created.id,
        deleteAfter: new Date(Date.now() + CONTEXT_DELETE_AFTER_MS).toISOString(),
      })
      if (registered.contextId !== created.id) {
        // A concurrent durable attempt won the unique run lease. Delete the
        // unused Context immediately and continue only with the recorded one.
        await deleteBrowserbaseContext(client, created.id, this.projectId)
      }
      return handleFromLease(registered)
    } catch (error) {
      const winner = await reconcileAmbiguousBrowserbaseContextRegistration({
        createdContextId: created.id,
        registrationError: error,
        loadWinner: () => loadBrowserContextLeaseForRun(input.runId),
        deleteCreatedContext: () => deleteBrowserbaseContext(client, created.id, this.projectId),
      })
      return handleFromLease(winner)
    }
  }

  private async requireContext(client: Browserbase, contextId: string) {
    try {
      const context = await client.contexts.retrieve(contextId)
      if (context.projectId !== this.projectId) {
        throw new BrowserContextRestoreError("The Context belongs to a different Browserbase project.")
      }
    } catch (error) {
      if (error instanceof BrowserContextRestoreError) throw error
      throw new BrowserContextRestoreError("The persisted Browserbase Context is unavailable; the phase was not replayed.")
    }
  }
}

function browserProxySubjectForRun(runId: string) {
  const canonicalRunId = runId.trim().toLowerCase()
  if (!UUID.test(canonicalRunId)) {
    throw new Error("The eval run identifier is invalid for a browser proxy credential.")
  }
  return `run:${canonicalRunId}`
}

type BrowserContextLeaseHandle = {
  contextId: string
  lastSessionId: string | null
  resumeUrl: string | null
  readyAt: string
}

function handleFromLease(lease: BrowserContextLeaseHandle): BrowserSessionHandle {
  return {
    provider: "browserbase",
    contextId: lease.contextId,
    lastSessionId: lease.lastSessionId,
    resumeUrl: lease.resumeUrl,
    readyAt: lease.readyAt,
  }
}
