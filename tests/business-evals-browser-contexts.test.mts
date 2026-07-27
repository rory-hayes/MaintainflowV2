import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  BROWSERBASE_CONTEXT_MAX_SYNC_WAIT_MS,
  BrowserContextRestoreError,
  browserContextSynchronizationWaitMs,
  reconcileAmbiguousBrowserbaseContextRegistration,
  requireBrowserbaseAllowedDomains,
  resolveBrowserbaseContextReleaseTarget,
  sanitizeBrowserResumeUrl,
  waitForBrowserContextSynchronization,
} from "../src/lib/runner/browser-context-policy.ts"

test("Browserbase allowed domains are normalized but never replace the catch-all proxy", () => {
  assert.deepEqual(
    requireBrowserbaseAllowedDomains(["APP.Example.com", "app.example.com", "auth.example.com"]),
    ["app.example.com", "auth.example.com"]
  )
  assert.throws(() => requireBrowserbaseAllowedDomains([]), /between 1 and 32/)
  assert.throws(() => requireBrowserbaseAllowedDomains(["*.example.com"]), /invalid approved domain/)
  assert.throws(() => requireBrowserbaseAllowedDomains(["https://example.com"]), /invalid approved domain/)

  const provider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  assert.match(provider, /allowedDomains,/)
  assert.match(provider, /proxies: externalEgress\.proxies/)
  assert.match(provider, /proxySettings: externalEgress\.proxySettings/)
  assert.match(provider, /allowedDomains protects approved main-frame navigation/)
  assert.match(provider, /catch-all proxy remains the egress boundary/)
})

test("durable resume locations retain only an approved HTTPS origin and path", () => {
  assert.equal(
    sanitizeBrowserResumeUrl("https://app.example.com/account?token=secret#private", ["example.com"]),
    "https://app.example.com/account"
  )
  assert.equal(sanitizeBrowserResumeUrl("https://notexample.com/account", ["example.com"]), null)
  assert.equal(sanitizeBrowserResumeUrl("http://app.example.com/account", ["example.com"]), null)
  assert.equal(sanitizeBrowserResumeUrl(`https://${"user"}:${"pass"}@app.example.com/account`, ["example.com"]), null)
})

test("Context synchronization waits are bounded and corrupt handles fail closed", async () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z")
  assert.equal(browserContextSynchronizationWaitMs("2026-07-20T12:00:05.000Z", now), 5_000)
  assert.equal(browserContextSynchronizationWaitMs("2026-07-20T11:59:59.000Z", now), 0)
  assert.throws(
    () => browserContextSynchronizationWaitMs(new Date(now + BROWSERBASE_CONTEXT_MAX_SYNC_WAIT_MS + 1).toISOString(), now),
    BrowserContextRestoreError
  )
  assert.throws(() => browserContextSynchronizationWaitMs("not-a-date", now), BrowserContextRestoreError)

  const waits: number[] = []
  await waitForBrowserContextSynchronization("2026-07-20T12:00:05.000Z", {
    now: () => now,
    wait: async (milliseconds) => { waits.push(milliseconds) },
  })
  assert.deepEqual(waits, [5_000])
})

test("each durable phase uses a fresh non-keepalive Context session and final release deletes the Context", () => {
  const provider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")

  assert.match(provider, /client\.sessions\.create\(\{/)
  assert.match(provider, /new Browserbase\(\{ apiKey: this\.apiKey, maxRetries: 0, timeout: 30_000 \}\)/)
  assert.doesNotMatch(provider, /new Browserbase\(\{ apiKey: this\.apiKey, maxRetries: [1-9]/)
  assert.match(provider, /keepAlive: false/)
  assert.match(provider, /context: \{ id: session\.contextId, persist: true \}/)
  assert.match(provider, /if \(browser\)[\s\S]*await browser\.close\(\)/)
  assert.doesNotMatch(provider, /keepAlive: true/)
  assert.doesNotMatch(provider, /current\?\.connectUrl|sessions\.retrieve\(session\.sessionId\)/)
  assert.match(provider, /requestBrowserbaseSessionReleaseIfStranded\(client, target\.lastSessionId, this\.projectId\)[\s\S]*deleteBrowserbaseContext\(client, target\.contextId, this\.projectId\)/)
  assert.match(provider, /releaseBrowserContextLease\(\{ runId, contextId: target\.contextId \}\)/)
  assert.match(engine, /await connected\.beforeDisconnect\?\.\(\)/)
  assert.doesNotMatch(engine, /beforeDisconnect\?\.\(\)\.catch/)

  assert.match(workflow, /executeBrowserPhaseStep\(context, beforeEmail, undefined, workerId, false, "create"\)/)
  assert.match(workflow, /executeBrowserPhaseStep\(context, postEmailStages, session, workerId, true, "restore"\)/)
  assert.match(workflow, /contextMode: "restore"/)
  assert.match(workflow, /isBrowserContextRestoreError\(error\) \? "BROWSER_CONTEXT_RESTORE_FAILED"/)
  assert.match(workflow, /cleanupStages\.some\(hasInProductCleanupAction\)[\s\S]*loadBrowserContextForCleanupStep\(context\.runId\)/)
  assert.match(workflow, /getBrowserEvalProvider\(\)\.loadRunContext\(runId\)/)
  assert.match(workflow, /finally \{[\s\S]*releaseBrowserContextStep\(context\.runId, session\)/)
})

test("Context readiness begins only after the short-lived session shutdown completes", () => {
  const provider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  const executePhase = provider.slice(
    provider.indexOf("async executePhase"),
    provider.indexOf("async releaseRunContext")
  )
  const closeAt = executePhase.indexOf("await browser.close()")
  const releaseAt = executePhase.indexOf("await requestBrowserbaseSessionReleaseIfStranded", closeAt)
  const readyAt = executePhase.indexOf("readyAt = new Date", releaseAt)
  const persistAt = executePhase.indexOf("await completeBrowserContextSession", readyAt)
  const returnAt = executePhase.indexOf("return {\n      ...phase", persistAt)

  assert.ok(closeAt >= 0, "browser close must be present")
  assert.ok(releaseAt > closeAt, "release backstop must run after browser close")
  assert.ok(readyAt > releaseAt, "readyAt must be calculated after the release backstop")
  assert.ok(persistAt > readyAt, "the post-shutdown readyAt must be persisted")
  assert.ok(returnAt > persistAt, "the result must be constructed after teardown and persistence")
  assert.match(executePhase.slice(returnAt), /session: \{[\s\S]*readyAt,[\s\S]*\},\s*\}/)
  assert.match(executePhase, /lastSessionId: lastSessionId \?\? session\.lastSessionId/)
})

test("ambiguous Context registration reconciles before deciding whether deletion is safe", async () => {
  const registrationError = new Error("registration response lost")

  const sameWinnerEvents: string[] = []
  const sameWinner = await reconcileAmbiguousBrowserbaseContextRegistration({
    createdContextId: "ctx-created",
    registrationError,
    loadWinner: async () => {
      sameWinnerEvents.push("load")
      return { contextId: "ctx-created", marker: "authoritative" }
    },
    deleteCreatedContext: async () => { sameWinnerEvents.push("delete") },
  })
  assert.equal(sameWinner.contextId, "ctx-created")
  assert.deepEqual(sameWinnerEvents, ["load"])

  const differentWinnerEvents: string[] = []
  const differentWinner = await reconcileAmbiguousBrowserbaseContextRegistration({
    createdContextId: "ctx-loser",
    registrationError,
    loadWinner: async () => {
      differentWinnerEvents.push("load")
      return { contextId: "ctx-winner" }
    },
    deleteCreatedContext: async () => { differentWinnerEvents.push("delete") },
  })
  assert.equal(differentWinner.contextId, "ctx-winner")
  assert.deepEqual(differentWinnerEvents, ["load", "delete"])

  const missingWinnerEvents: string[] = []
  await assert.rejects(
    () => reconcileAmbiguousBrowserbaseContextRegistration({
      createdContextId: "ctx-unregistered",
      registrationError,
      loadWinner: async () => {
        missingWinnerEvents.push("load")
        return null
      },
      deleteCreatedContext: async () => { missingWinnerEvents.push("delete") },
    }),
    (error) => error === registrationError
  )
  assert.deepEqual(missingWinnerEvents, ["load", "delete"])

  const failedReconciliationEvents: string[] = []
  await assert.rejects(
    () => reconcileAmbiguousBrowserbaseContextRegistration({
      createdContextId: "ctx-possibly-registered",
      registrationError,
      loadWinner: async () => {
        failedReconciliationEvents.push("load")
        throw new Error("lease read unavailable")
      },
      deleteCreatedContext: async () => { failedReconciliationEvents.push("delete") },
    }),
    (error) => error === registrationError
  )
  assert.deepEqual(failedReconciliationEvents, ["load"])
})

test("final Context release trusts the current lease while validating the workflow handle", () => {
  const lease = {
    contextId: "ctx-current",
    lastSessionId: "session-current",
    readyAt: "2026-07-20T12:00:05.000Z",
  }
  const staleWorkflowHandle = {
    provider: "browserbase",
    contextId: "ctx-current",
    lastSessionId: "session-stale",
    readyAt: "2026-07-20T11:59:05.000Z",
  }

  assert.deepEqual(resolveBrowserbaseContextReleaseTarget(lease, staleWorkflowHandle), lease)
  assert.throws(
    () => resolveBrowserbaseContextReleaseTarget(lease, { ...staleWorkflowHandle, provider: "local_playwright" }),
    BrowserContextRestoreError
  )
  assert.throws(
    () => resolveBrowserbaseContextReleaseTarget(lease, { ...staleWorkflowHandle, contextId: "ctx-other" }),
    BrowserContextRestoreError
  )
  assert.deepEqual(resolveBrowserbaseContextReleaseTarget(null, staleWorkflowHandle), {
    contextId: "ctx-current",
    lastSessionId: "session-stale",
    readyAt: "2026-07-20T11:59:05.000Z",
  })
  assert.equal(resolveBrowserbaseContextReleaseTarget(null), null)
})

test("private durable leases enforce one sequential session and bounded abandoned-Context cleanup", () => {
  const leases = readFileSync("src/lib/runner/browser-context-leases.server.ts", "utf8")
  const janitor = readFileSync("src/lib/runner/browser-context-cleanup.ts", "utf8")
  const cronRoute = readFileSync("src/app/api/cron/cleanup-browser-contexts/route.ts", "utf8")
  const evalCronRoute = readFileSync("src/app/api/cron/run-evals/route.ts", "utf8")
  const providerJanitor = readFileSync("src/lib/runner/browserbase-context-cleanup.server.ts", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const additiveMigration = readFileSync("supabase/maintainflow_browser_context_leases_migration.sql", "utf8")
  const schedulerMigration = readFileSync("supabase/maintainflow_browser_context_cleanup_scheduler_migration.sql", "utf8")
  const productionMigrations = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")

  assert.match(migration, /create table if not exists public\.browser_context_leases/)
  assert.match(migration, /unique \(eval_run_id\)/)
  assert.match(migration, /unique \(context_id\)/)
  assert.match(migration, /session_owner_token/)
  assert.match(migration, /session_lease_expires_at/)
  assert.match(migration, /for update skip locked/)
  assert.match(migration, /p_limit not between 1 and 20/)
  assert.match(migration, /limit p_limit[\s\S]*for update skip locked/)
  assert.match(migration, /alter table public\.browser_context_leases enable row level security/)
  assert.match(migration, /revoke all on table public\.browser_context_leases from public, anon, authenticated/)
  assert.match(additiveMigration, /create table if not exists public\.browser_context_leases/)
  assert.match(additiveMigration, /claim_browser_context_cleanup_batch/)
  assert.match(productionMigrations, /maintainflow_browser_context_leases_migration\.sql/)
  assert.match(productionMigrations, /await client\.query\(withoutTransactionWrapper\(browserContextLeasesMigration\)\)/)
  assert.match(productionMigrations, /maintainflow_browser_context_cleanup_scheduler_migration\.sql/)
  assert.match(productionMigrations, /await client\.query\(withoutTransactionWrapper\(browserContextCleanupSchedulerMigration\)\)/)
  assert.match(leases, /claim_browser_context_session/)
  assert.match(leases, /claim_browser_context_cleanup_batch/)
  assert.doesNotMatch(leases, /console\.(?:log|error|warn)/)
  assert.match(janitor, /maxConcurrency \?\? 4/)
  assert.match(janitor, /Math\.min\(21_600, 30 \* \(2 \*\* exponent\)\)/)
  assert.match(janitor, /releaseSession\(claim\.lastSessionId\)[\s\S]*deleteContext\(claim\.contextId\)/)
  assert.doesNotMatch(janitor, /console\.(?:log|error|warn)/)
  assert.match(cronRoute, /runBrowserbaseContextCleanupJanitor/)
  assert.match(cronRoute, /export const maxDuration = 60/)
  assert.match(cronRoute, /boundedBrowserbaseContextCleanupBatchSize\(requestedBatch\)/)
  assert.doesNotMatch(evalCronRoute, /runBrowserbaseContextCleanupJanitor/)
  assert.match(providerJanitor, /BROWSERBASE_CONTEXT_CLEANUP_DEFAULT_BATCH_SIZE = 4/)
  assert.match(providerJanitor, /BROWSERBASE_CONTEXT_CLEANUP_MAX_BATCH_SIZE = 4/)
  assert.match(providerJanitor, /BROWSERBASE_CONTEXT_CLEANUP_PROVIDER_TIMEOUT_MS = 5_000/)
  assert.match(providerJanitor, /BROWSERBASE_CONTEXT_CLEANUP_PROVIDER_MAX_RETRIES = 0/)
  assert.match(providerJanitor, /maxConcurrency: 4/)
  assert.match(schedulerMigration, /maintainflow-cleanup-browser-contexts/)
  assert.match(schedulerMigration, /\/api\/cron\/cleanup-browser-contexts/)
  assert.match(schedulerMigration, /'''batchSize'', 4/)
  assert.match(schedulerMigration, /timeout_milliseconds := 60000/)
  assert.doesNotMatch(schedulerMigration, /cron\.unschedule\('maintainflow-run-evals'\)/)
})
