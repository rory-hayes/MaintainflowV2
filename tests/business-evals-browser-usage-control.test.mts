import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  parseCanonicalPositiveSafeInteger,
  tryParseCanonicalPositiveSafeInteger,
} from "../scripts/lib/canonical-positive-integer.mjs"
import {
  browserbaseDailyReconciliationDue,
  browserbaseSessionMeteringRetryDelaySeconds,
  browserbaseSessionMeteringShouldEscalate,
  browserbaseUsageGuardVerdict,
  deriveBrowserbaseSessionUsage,
  parseBrowserbaseCommercialGuardConfig,
  parseBrowserbaseSessionMeteringPolicy,
  pollBrowserbaseTerminalSession,
} from "../src/lib/runner/browserbase-usage-policy.ts"

const migration = readFileSync("supabase/maintainflow_browser_provider_cost_controls_migration.sql", "utf8")
const schema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const provider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
const pageScan = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")
const usageControl = readFileSync("src/lib/runner/browserbase-usage-control.server.ts", "utf8")
const scheduler = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
const billing = readFileSync("src/components/evals/pages/settings-pages.tsx", "utf8")
const readiness = readFileSync("scripts/local-deploy-readiness.mjs", "utf8")
const envPush = readFileSync("scripts/push-vercel-env.mjs", "utf8")

test("deployment Browserbase numeric parsing matches runtime canonical positive integers", () => {
  const accepted = ["1", "80", "30000", " 95 ", String(Number.MAX_SAFE_INTEGER)]
  for (const value of accepted) {
    assert.equal(parseCanonicalPositiveSafeInteger(value, "BROWSERBASE_TEST_VALUE"), Number(value.trim()))
  }

  const rejected = ["", "0", "01", "1e3", "80.0", "+80", "-80", "80_0", "9007199254740992"]
  for (const value of rejected) {
    assert.throws(
      () => parseCanonicalPositiveSafeInteger(value, "BROWSERBASE_TEST_VALUE"),
      /explicit positive integer commercial ceiling|safe integer/
    )
    assert.equal(tryParseCanonicalPositiveSafeInteger(value, "BROWSERBASE_TEST_VALUE"), null)
  }

  const commercialEnv = {
    BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT: "30000",
    BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT: "5368709120",
    BROWSERBASE_USAGE_WARNING_PERCENT: "80",
  }
  for (const [key, value] of [
    ["BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT", "1e3"],
    ["BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT", "01"],
    ["BROWSERBASE_USAGE_WARNING_PERCENT", "80.0"],
  ] as const) {
    assert.throws(
      () => parseBrowserbaseCommercialGuardConfig({ ...commercialEnv, [key]: value }),
      /explicit positive integer commercial ceiling/
    )
  }
  for (const [key, value] of [
    ["BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS", "012"],
    ["BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES", "6e1"],
  ] as const) {
    assert.throws(
      () => parseBrowserbaseSessionMeteringPolicy({
        BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS: "12",
        BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES: "60",
        [key]: value,
      }),
      /explicit positive integer commercial ceiling/
    )
  }

  for (const source of [readiness, envPush]) {
    assert.match(source, /canonical-positive-integer\.mjs/)
    for (const key of [
      "BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT",
      "BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT",
      "BROWSERBASE_USAGE_WARNING_PERCENT",
      "BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS",
      "BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES",
    ]) {
      assert.match(source, new RegExp(`(?:tryP|p)arseCanonicalPositiveSafeInteger\\([\\s\\S]{0,120}${key}`))
    }
  }
})

test("commercial ceilings are explicit and provider usage determines warning or block", () => {
  const config = parseBrowserbaseCommercialGuardConfig({
    BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT: "30000",
    BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT: "5368709120",
    BROWSERBASE_USAGE_WARNING_PERCENT: "80",
  })
  assert.deepEqual(config, {
    monthlyBrowserMinutesLimit: 30_000,
    monthlyProxyBytesLimit: 5_368_709_120,
    warningPercent: 80,
  })
  assert.deepEqual(browserbaseUsageGuardVerdict({ browserMinutes: 23_999, proxyBytes: 1 }, config), {
    status: "healthy",
    reason: "",
    mayCreateSession: true,
  })
  assert.equal(browserbaseUsageGuardVerdict({ browserMinutes: 24_000, proxyBytes: 1 }, config).status, "warning")
  assert.deepEqual(browserbaseUsageGuardVerdict({ browserMinutes: 30_000, proxyBytes: 1 }, config), {
    status: "blocked",
    reason: "browser_minutes_limit",
    mayCreateSession: false,
  })
  assert.throws(
    () => parseBrowserbaseCommercialGuardConfig({ BROWSERBASE_MONTHLY_BROWSER_MINUTES_LIMIT: "30000" }),
    /BROWSERBASE_MONTHLY_PROXY_BYTES_LIMIT/
  )
})

test("per-session accounting derives duration and proxy bytes only from terminal provider fields", () => {
  assert.deepEqual(deriveBrowserbaseSessionUsage({
    projectId: "project_one",
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T10:02:30.500Z",
    status: "COMPLETED",
    proxyBytes: 1_048_576,
  }, "project_one"), {
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T10:02:30.500Z",
    durationMs: 150_500,
    activeMinutes: 150_500 / 60_000,
    proxyBytes: 1_048_576,
    status: "COMPLETED",
  })
  assert.throws(() => deriveBrowserbaseSessionUsage({
    projectId: "project_one",
    startedAt: "2026-07-20T10:00:00.000Z",
    status: "RUNNING",
    proxyBytes: 0,
  }, "project_one"), /terminal, metered/)
  assert.throws(() => deriveBrowserbaseSessionUsage({
    projectId: "other_project",
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T10:00:01.000Z",
    status: "COMPLETED",
    proxyBytes: 0,
  }, "project_one"), /different reviewed project/)
})

test("delayed terminalization remains retryable and later terminal metadata is accepted", async () => {
  let retrieval = 0
  const sessions = [
    { projectId: "project_one", startedAt: "2026-07-20T10:00:00.000Z", status: "RUNNING", proxyBytes: 0 },
    { projectId: "project_one", startedAt: "2026-07-20T10:00:00.000Z", status: "RUNNING", proxyBytes: 0 },
    { projectId: "project_one", startedAt: "2026-07-20T10:00:00.000Z", endedAt: "2026-07-20T10:00:20.000Z", status: "COMPLETED", proxyBytes: 512 },
  ]
  const first = await pollBrowserbaseTerminalSession({
    retrieve: async () => sessions[retrieval++],
    expectedProjectId: "project_one",
    delaysMs: [0, 250],
    sleep: async () => undefined,
  })
  assert.equal(first.kind, "pending")
  assert.equal(first.attempts, 2)
  const retry = await pollBrowserbaseTerminalSession({
    retrieve: async () => sessions[retrieval++],
    expectedProjectId: "project_one",
    delaysMs: [0],
  })
  assert.equal(retry.kind, "terminal")
  assert.equal(retry.attempts, 1)
})

test("metering retries use bounded backoff and escalate only at reviewed age or attempt limits", () => {
  const policy = parseBrowserbaseSessionMeteringPolicy({
    BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS: "12",
    BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES: "60",
  })
  assert.deepEqual(policy, { maxAttempts: 12, maxAgeMinutes: 60 })
  assert.equal(browserbaseSessionMeteringRetryDelaySeconds(0), 30)
  assert.equal(browserbaseSessionMeteringRetryDelaySeconds(20), 600)
  const firstPendingAt = "2026-07-20T10:00:00.000Z"
  assert.equal(browserbaseSessionMeteringShouldEscalate({
    attemptCount: 11,
    firstPendingAt,
    nowMs: Date.parse("2026-07-20T10:59:59.999Z"),
  }, policy), false)
  assert.equal(browserbaseSessionMeteringShouldEscalate({
    attemptCount: 12,
    firstPendingAt,
    nowMs: Date.parse("2026-07-20T10:10:00.000Z"),
  }, policy), true)
  assert.equal(browserbaseSessionMeteringShouldEscalate({
    attemptCount: 2,
    firstPendingAt,
    nowMs: Date.parse("2026-07-20T11:00:00.000Z"),
  }, policy), true)
})

test("daily reconciliation cadence is deterministic", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z")
  assert.equal(browserbaseDailyReconciliationDue(null, now), true)
  assert.equal(browserbaseDailyReconciliationDue("2026-07-19T12:00:00.001Z", now), false)
  assert.equal(browserbaseDailyReconciliationDue("2026-07-19T12:00:00.000Z", now), true)
})

test("Browserbase session creation, scheduler, billing, and SQL all share the fail-closed control", () => {
  for (const source of [provider, pageScan]) {
    const guard = source.indexOf("assertBrowserbaseSessionCommerciallyAllowed")
    const prepare = source.indexOf("prepareBrowserbaseSessionCreation")
    const create = source.indexOf("client.sessions.create")
    const register = source.indexOf("registerBrowserbaseSessionForMetering", create)
    const connect = source.indexOf("chromium.connectOverCDP", create)
    assert.ok(guard >= 0 && create >= 0 && guard < create, "Provider usage must be checked before Browserbase session creation.")
    assert.ok(prepare >= 0 && prepare < create, "A durable creation intent must exist before Browserbase session creation.")
    assert.ok(register > create && connect > register, "The provider session ID must be durably registered before browser use.")
    assert.match(source, /recordTerminalBrowserbaseSessionUsage/)
    assert.match(source, /markBrowserbaseSessionCreationUncertain/)
    assert.match(source, /userMetadata: \{ mf_intent: creationIntent\.correlationToken \}/)
  }
  assert.match(scheduler, /reconcileBrowserbaseProjectUsageIfDue/)
  assert.match(scheduler, /pausedByBrowserUsage: true/)
  assert.match(usageControl, /rpc\/claim_browser_provider_session_metering/)
  assert.match(usageControl, /rpc\/claim_browser_provider_project_usage_sample/)
  assert.match(usageControl, /rpc\/claim_browser_provider_session_creation_reconciliation/)
  assert.match(usageControl, /user_metadata\['mf_intent'\]:'\$\{creationIntent\.correlationToken\}'/)
  assert.match(usageControl, /rpc\/begin_browser_provider_session_terminal_metering/)
  assert.match(usageControl, /BROWSERBASE_SESSION_METERING_RETRY_BATCH_SIZE/)
  assert.match(billing, /Managed browser usage/)
  assert.match(billing, /Session active time/)
  assert.match(billing, /not Browserbase billed project minutes/)
  assert.match(billing, /Proxy data/)
  for (const table of [
    "browser_provider_cost_controls",
    "browser_provider_session_usage",
    "browser_provider_usage_snapshots",
    "browser_provider_session_metering_queue",
    "browser_provider_session_creation_intents",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`))
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  assert.match(migration, /provider_counter_decreased/)
  assert.match(migration, /session_usage_unresolved/)
  assert.match(migration, /session_usage_pending/)
  assert.match(migration, /claim_browser_provider_session_metering/)
  assert.match(migration, /defer_browser_provider_session_metering/)
  assert.match(migration, /claim_browser_provider_daily_reconciliation[\s\S]*usage_sample_claimed_by = p_worker_id/)
  assert.match(migration, /prepare_browser_provider_session_creation[\s\S]*for update;[\s\S]*SESSION_CREATION_CONTROL_BLOCKED/)
  assert.match(migration, /reopen_browser_provider_session_metering/)
  assert.match(migration, /reopen_browser_provider_session_creation_reconciliation/)
  assert.match(migration, /BROWSER_PROVIDER_SESSION_METERING_REOPEN_ACTOR_UNAUTHORIZED/)
  assert.match(migration, /BROWSER_PROVIDER_SESSION_CREATION_REOPEN_ACTOR_UNAUTHORIZED/)
  assert.match(migration, /membership\.role in \('owner'::public\.agency_role, 'admin'::public\.agency_role\)/)
  assert.match(migration, /revoke all on table public\.browser_provider_session_usage from public, anon, authenticated, service_role/)
})

test("metering policy is validated before provider usage or session creation", () => {
  assert.throws(() => parseBrowserbaseSessionMeteringPolicy({}), /BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS/)
  assert.throws(() => parseBrowserbaseSessionMeteringPolicy({
    BROWSERBASE_SESSION_METERING_MAX_ATTEMPTS: "1e3",
    BROWSERBASE_SESSION_METERING_MAX_AGE_MINUTES: "60",
  }), /explicit positive integer commercial ceiling/)
  const guardStart = usageControl.indexOf("export async function assertBrowserbaseSessionCommerciallyAllowed")
  const policy = usageControl.indexOf("parseBrowserbaseSessionMeteringPolicy(env)", guardStart)
  const claim = usageControl.indexOf("claimBrowserbaseProjectUsageSample", policy)
  const providerUsage = usageControl.indexOf("sampleProjectUsage", claim)
  assert.ok(guardStart >= 0 && policy > guardStart && claim > policy && providerUsage > claim)
})

test("fresh and additive browser-provider cost-control schemas remain byte-equivalent", () => {
  const migrationBody = migration.slice(migration.indexOf("create table if not exists"), migration.lastIndexOf("commit;")).trim()
  const schemaBody = schema.slice(
    schema.indexOf("create table if not exists public.browser_provider_cost_controls"),
    schema.indexOf("-- Legal-acceptance fresh-schema extension")
  ).trim()
  assert.equal(schemaBody, migrationBody)
})
