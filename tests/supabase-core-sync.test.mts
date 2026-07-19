import assert from "node:assert/strict"
import test from "node:test"
import {
  createAgencyWorkspace,
  createClientRecord,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  recordIssueRepair,
  runWorkflowCheck,
  scopedData,
  updateAgency,
} from "../src/lib/core/local-store.ts"
import type { EndpointTestResult } from "../src/lib/core/types.ts"
import { loadCoreDatabaseFromSupabase, syncCoreDatabaseToSupabase, updateAgencyInSupabase } from "../src/lib/supabase/core-sync.ts"
import { SUPABASE_SESSION_KEY } from "../src/lib/supabase/config.ts"

const user = {
  id: "user_1",
  name: "Alex Morgan",
  email: "alex@maintainflow.test",
  company: "Northstar Automations",
  role: "Agency Founder",
}

test("Supabase sync writes core-loop records and reloads tenant-scoped readback", async () => {
  const harness = installSupabaseHarness()
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  const membership = database.memberships[0]
  harness.seed("agencies", [agencyToRow(agency)])
  harness.seed("memberships", [membershipToRow(membership)])

  database = createClientRecord(database, agency.id, user.id, {
    name: "Acme AI Systems",
    reportRecipientEmail: "ops@acme.example",
  })
  const client = database.clients[0]
  const healthyResult: EndpointTestResult = {
    status: "healthy",
    statusCode: 200,
    latencyMs: 141,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":true}",
    errorMessage: "",
  }
  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Lead enrichment API",
    endpointUrl: "https://status.example.com/healthy",
    method: "GET",
    headers: {},
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5000,
    frequencyMinutes: 60,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    environment: "production",
    type: "http_endpoint",
    assertions: [{ id: "response-exists", type: "response_exists", enabled: true }],
  }, healthyResult)

  try {
    await syncCoreDatabaseToSupabase(database, [agency.id])
    const writtenTables = harness.calls.filter((call) => call.method === "POST").map((call) => call.table)
    assert.deepEqual(writtenTables.slice(0, 4), ["legacy-core-sync", "legacy-core-sync", "checks", "check_runs"])
    assert.deepEqual(
      harness.calls
        .filter((call) => call.table === "legacy-core-sync")
        .map((call) => (call.body as { table: string }).table),
      ["clients", "workflows"]
    )
    assert.equal(harness.calls.some((call) => /\/rest\/v1\/(clients|workflows)$/.test(call.pathname)), false)
    assert.equal(writtenTables.includes("agencies"), false)
    assert.equal(writtenTables.includes("memberships"), false)
    assert.equal(
      harness.calls.find((call) => call.method === "POST" && call.table === "audit_events")?.headers.Prefer,
      "resolution=ignore-duplicates,return=minimal"
    )

    const storedRun = harness.rows("check_runs")[0]
    const postgresStartedAt = postgrestMicrosecondTimestamp(String(storedRun.started_at))
    harness.patchRow("check_runs", storedRun.id, {
      started_at: postgresStartedAt,
      completed_at: postgrestTimestamp(String(storedRun.completed_at)),
      created_at: postgrestTimestamp(String(storedRun.created_at)),
    })

    const reloaded = await loadCoreDatabaseFromSupabase(user.id)
    const scoped = scopedData(reloaded, agency.id)

    assert.equal(scoped.clients.length, 1)
    assert.equal(scoped.clients[0].id, client.id)
    assert.equal(scoped.workflows.length, 1)
    assert.equal(scoped.workflows[0].clientId, client.id)
    assert.equal(scoped.checks.length, 1)
    assert.equal(scoped.checks[0].workflowId, scoped.workflows[0].id)
    assert.equal(harness.rows("check_runs").length, 1)
    assert.equal(scoped.checkRuns.length, 0)
    assert.equal(scoped.auditEvents.some((event) => event.entityType === "workflow"), true)
  } finally {
    harness.restore()
  }
})

test("mutable-row compare-and-swap preserves PostgreSQL microsecond tokens", async () => {
  const harness = installSupabaseHarness()
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Northstar Automations",
    slug: "northstar",
  })
  const agency = database.agencies[0]
  harness.seed("agencies", [agencyToRow(agency)])
  harness.seed("memberships", [membershipToRow(database.memberships[0])])
  database = createClientRecord(database, agency.id, user.id, { name: "Acme AI Systems" })
  const rawVersion = "2026-07-13T12:34:56.123456+00:00"
  harness.seed("clients", [{ ...clientToRow(database.clients[0]), updated_at: rawVersion }])

  try {
    const previous = await loadCoreDatabaseFromSupabase(user.id)
    assert.equal(previous.clients[0].updatedAt, rawVersion)
    const next = {
      ...previous,
      clients: previous.clients.map((client) => client.id === database.clients[0].id
        ? { ...client, name: "Acme AI Operations", updatedAt: "2026-07-13T12:35:00.000Z" }
        : client),
    }

    await syncCoreDatabaseToSupabase(next, [agency.id], previous)

    const serverSync = harness.calls.find(
      (call) => call.table === "legacy-core-sync" && (call.body as { table?: string })?.table === "clients"
    )
    assert.ok(serverSync)
    assert.equal(
      (serverSync.body as { updates: Array<{ expectedUpdatedAt: string }> }).updates[0]?.expectedUpdatedAt,
      rawVersion
    )
    assert.equal(harness.calls.some((call) => call.method === "PATCH" && call.table === "clients"), false)
    assert.equal(harness.rows("clients")[0].name, "Acme AI Operations")
  } finally {
    harness.restore()
  }
})

test("agency profile save uses a constrained Supabase update instead of an insert upsert", async () => {
  const harness = installSupabaseHarness()
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  harness.seed("agencies", [agencyToRow(agency)])
  database = updateAgency(database, agency.id, {
    name: "Northstar Maintenance",
    slug: "northstar-maintenance",
    reportSenderName: "Ops Team",
    reportSenderEmail: "ops@northstar.example",
  }, user.id)
  database = {
    ...database,
    agencies: database.agencies.map((item) => item.id === agency.id
      ? { ...item, updatedAt: new Date(new Date(agency.updatedAt).getTime() + 1_000).toISOString() }
      : item),
  }

  try {
    await updateAgencyInSupabase(database.agencies[0], agency.updatedAt)
    assert.equal(harness.calls.length, 1)
    assert.equal(harness.calls[0].method, "PATCH")
    assert.equal(harness.calls[0].table, "agencies")
    assert.equal(harness.calls[0].searchParams.get("id"), `eq.${agency.id}`)
    assert.equal(harness.calls[0].searchParams.get("updated_at"), `eq.${agency.updatedAt}`)
    assert.equal(harness.calls[0].headers.Prefer, "return=representation")
    assert.deepEqual(harness.calls[0].body, {
      name: "Northstar Maintenance",
      slug: "northstar-maintenance",
      report_sender_name: "Ops Team",
      report_sender_email: "ops@northstar.example",
      updated_at: database.agencies[0].updatedAt,
    })
    assert.equal(harness.rows("agencies")[0].name, "Northstar Maintenance")
    assert.equal(harness.rows("agencies")[0].updated_at, database.agencies[0].updatedAt)
  } finally {
    harness.restore()
  }
})

test("an unrelated browser edit preserves newer scheduler state and evidence", async () => {
  const harness = installSupabaseHarness()
  let previous = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Northstar Automations",
    slug: "northstar",
  })
  const agency = previous.agencies[0]
  harness.seed("agencies", [agencyToRow(agency)])
  harness.seed("memberships", [membershipToRow(previous.memberships[0])])
  previous = createClientRecord(previous, agency.id, user.id, { name: "Acme AI Systems" })
  const client = previous.clients[0]
  previous = createWorkflowWithFirstRun(previous, agency.id, user.id, {
    clientId: client.id,
    name: "Invoice intake monitor",
    endpointUrl: "https://status.example.com/invoice-intake",
    method: "GET",
    headers: {},
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
    frequencyMinutes: 60,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    environment: "production",
    type: "http_endpoint",
    assertions: [],
  }, failedResult())

  try {
    await syncCoreDatabaseToSupabase(previous, [agency.id])
    harness.clearCalls()

    const schedulerAt = "2026-07-13T12:00:00.000Z"
    const workflowId = previous.workflows[0].id
    const checkId = previous.checks[0].id
    const issueId = previous.issues[0].id
    const scheduledRunId = "00000000-0000-4000-8000-000000000099"
    harness.patchRow("workflows", workflowId, {
      status: "healthy",
      health_score: 100,
      last_check_run_at: schedulerAt,
      updated_at: schedulerAt,
    })
    harness.patchRow("checks", checkId, {
      last_run_at: schedulerAt,
      next_run_at: "2026-07-13T13:00:00.000Z",
      updated_at: schedulerAt,
    })
    harness.patchRow("issues", issueId, {
      occurrence_count: 4,
      updated_at: schedulerAt,
    })
    harness.seed("check_runs", [
      ...harness.rows("check_runs"),
      {
        ...harness.rows("check_runs")[0],
        id: scheduledRunId,
        status: "healthy",
        status_code: 200,
        started_at: schedulerAt,
        completed_at: schedulerAt,
        created_at: schedulerAt,
      },
    ])

    const browserUpdatedAt = "2026-07-13T12:05:00.000Z"
    const next = {
      ...previous,
      clients: previous.clients.map((item) => item.id === client.id
        ? { ...item, name: "Acme AI Operations", updatedAt: browserUpdatedAt }
        : item),
    }
    await syncCoreDatabaseToSupabase(next, [agency.id], previous)

    assert.deepEqual(harness.calls.filter((call) => call.method === "PATCH").map((call) => call.table), [])
    assert.equal(
      harness.calls.some(
        (call) => call.table === "legacy-core-sync" && (call.body as { table?: string })?.table === "clients"
      ),
      true
    )
    assert.equal(harness.rows("workflows").find((row) => row.id === workflowId)?.status, "healthy")
    assert.equal(harness.rows("checks").find((row) => row.id === checkId)?.next_run_at, "2026-07-13T13:00:00.000Z")
    assert.equal(harness.rows("issues").find((row) => row.id === issueId)?.occurrence_count, 4)
    assert.equal(harness.rows("check_runs").some((row) => row.id === scheduledRunId), true)
  } finally {
    harness.restore()
  }
})

test("a stale mutable-row write fails its updated-at compare-and-swap", async () => {
  const harness = installSupabaseHarness()
  let previous = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Northstar Automations",
    slug: "northstar",
  })
  const agency = previous.agencies[0]
  harness.seed("agencies", [agencyToRow(agency)])
  harness.seed("memberships", [membershipToRow(previous.memberships[0])])
  previous = createClientRecord(previous, agency.id, user.id, { name: "Acme AI Systems" })
  const client = previous.clients[0]

  try {
    await syncCoreDatabaseToSupabase(previous, [agency.id])
    harness.clearCalls()
    harness.patchRow("clients", client.id, {
      name: "Server-side scheduler name",
      updated_at: "2026-07-13T12:00:00.000Z",
    })
    const next = {
      ...previous,
      clients: previous.clients.map((item) => item.id === client.id
        ? { ...item, name: "Stale browser name", updatedAt: "2026-07-13T12:05:00.000Z" }
        : item),
    }

    await assert.rejects(
      syncCoreDatabaseToSupabase(next, [agency.id], previous),
      /clients changed in another session/
    )
    const serverSync = harness.calls.find(
      (call) => call.table === "legacy-core-sync" && (call.body as { table?: string })?.table === "clients"
    )
    assert.ok(serverSync)
    assert.equal(
      (serverSync.body as { updates: Array<{ expectedUpdatedAt: string }> }).updates[0]?.expectedUpdatedAt,
      client.updatedAt
    )
    assert.equal(harness.calls.some((call) => call.method === "PATCH" && call.table === "clients"), false)
    assert.equal(harness.rows("clients")[0].name, "Server-side scheduler name")
    assert.equal(harness.rows("clients")[0].updated_at, "2026-07-13T12:00:00.000Z")
  } finally {
    harness.restore()
  }
})

test("existing check runs are append-only and are never overwritten by browser sync", async () => {
  const harness = installSupabaseHarness()
  let previous = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Northstar Automations",
    slug: "northstar",
  })
  const agency = previous.agencies[0]
  harness.seed("agencies", [agencyToRow(agency)])
  harness.seed("memberships", [membershipToRow(previous.memberships[0])])
  previous = createClientRecord(previous, agency.id, user.id, { name: "Acme AI Systems" })
  previous = createWorkflowWithFirstRun(previous, agency.id, user.id, {
    clientId: previous.clients[0].id,
    name: "Invoice intake monitor",
    endpointUrl: "https://status.example.com/invoice-intake",
    method: "GET",
    headers: {},
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
    frequencyMinutes: 60,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    environment: "production",
    type: "http_endpoint",
    assertions: [],
  }, failedResult())

  try {
    await syncCoreDatabaseToSupabase(previous, [agency.id])
    harness.clearCalls()
    const existingRun = previous.checkRuns[0]
    harness.patchRow("check_runs", existingRun.id, {
      status: "healthy",
      status_code: 200,
      safe_response_summary: "Server-issued evidence",
    })
    const newRun = {
      ...existingRun,
      id: "00000000-0000-4000-8000-000000000100",
      status: "healthy" as const,
      statusCode: 200,
      safeResponseSummary: "New client run",
      errorMessage: "",
      startedAt: "2026-07-13T13:00:00.000Z",
      completedAt: "2026-07-13T13:00:01.000Z",
      createdAt: "2026-07-13T13:00:01.000Z",
    }
    const next = {
      ...previous,
      checkRuns: [
        newRun,
        { ...existingRun, status: "degraded" as const, safeResponseSummary: "Stale browser evidence" },
      ],
    }

    await syncCoreDatabaseToSupabase(next, [agency.id], previous)

    const checkRunWrites = harness.calls.filter((call) => call.table === "check_runs")
    assert.equal(checkRunWrites.some((call) => call.method === "PATCH"), false)
    assert.equal(checkRunWrites.length, 1)
    assert.deepEqual(
      (checkRunWrites[0].body as Array<Record<string, unknown>>).map((row) => row.id),
      [newRun.id]
    )
    const persistedExisting = harness.rows("check_runs").find((row) => row.id === existingRun.id)
    assert.equal(persistedExisting?.status, "healthy")
    assert.equal(persistedExisting?.safe_response_summary, "Server-issued evidence")
    assert.equal(harness.rows("check_runs").some((row) => row.id === newRun.id), true)
  } finally {
    harness.restore()
  }
})

test("a different newer failure reopens prior verified issue truth before Supabase sync", async () => {
  const harness = installSupabaseHarness({ enforceIssueVerificationTruth: true })
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Northstar Automations",
    slug: "northstar",
  })
  const agency = database.agencies[0]
  harness.seed("agencies", [agencyToRow(agency)])
  harness.seed("memberships", [membershipToRow(database.memberships[0])])
  database = createClientRecord(database, agency.id, user.id, { name: "Acme AI Systems" })
  const client = database.clients[0]
  const failureA: EndpointTestResult = {
    status: "failed",
    statusCode: 500,
    latencyMs: 500,
    assertionResults: [],
    safeResponseSummary: "The endpoint returned an unexpected response.",
    errorMessage: "Expected 200 but received 500.",
  }
  const failureB: EndpointTestResult = {
    ...failureA,
    statusCode: 503,
    errorMessage: "Expected 200 but received 503.",
  }
  const healthy: EndpointTestResult = {
    status: "healthy",
    statusCode: 200,
    latencyMs: 140,
    assertionResults: [],
    safeResponseSummary: "The endpoint returned the expected healthy response.",
    errorMessage: "",
  }

  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Invoice intake monitor",
    endpointUrl: "https://status.example.com/invoice-intake",
    method: "GET",
    headers: {},
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
    frequencyMinutes: 60,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    environment: "production",
    type: "http_endpoint",
    assertions: [],
  }, failureA)
  const workflowId = database.workflows[0].id
  const priorIssueId = database.issues[0].id
  const priorDedupeKey = database.issues[0].dedupeKey
  const failureARunId = database.checkRuns[0].id
  database = {
    ...database,
    checkRuns: database.checkRuns.map((run) =>
      run.id === failureARunId
        ? {
            ...run,
            startedAt: "2026-07-13T09:00:00.000Z",
            completedAt: "2026-07-13T09:00:01.000Z",
            createdAt: "2026-07-13T09:00:01.000Z",
          }
        : run
    ),
  }
  database = recordIssueRepair(database, agency.id, user.id, priorIssueId, "The first failure was repaired.")
  database = {
    ...database,
    issues: database.issues.map((issue) =>
      issue.id === priorIssueId
        ? { ...issue, repairRecordedAt: "2026-07-13T09:30:00.000Z" }
        : issue
    ),
  }
  database = runWorkflowCheck(
    database,
    agency.id,
    user.id,
    workflowId,
    database.checks[0].id,
    healthy,
    "manual_run",
    "2026-07-13T10:00:00.000Z"
  )
  const verificationRunId = database.checkRuns[0].id
  database = {
    ...database,
    checkRuns: database.checkRuns.map((run) =>
      run.id === verificationRunId
        ? { ...run, completedAt: "2026-07-13T10:00:01.000Z", createdAt: "2026-07-13T10:00:01.000Z" }
        : run
    ),
    issues: database.issues.map((issue) =>
      issue.id === priorIssueId
        ? { ...issue, resolvedAt: "2026-07-13T10:00:01.000Z", updatedAt: "2026-07-13T10:00:01.000Z" }
        : issue
    ),
  }
  assert.equal(database.issues.find((issue) => issue.id === priorIssueId)?.status, "resolved")

  database = runWorkflowCheck(
    database,
    agency.id,
    user.id,
    workflowId,
    database.checks[0].id,
    failureB,
    "manual_run",
    "2026-07-13T11:00:00.000Z"
  )
  const failureBRunId = database.checkRuns[0].id
  database = {
    ...database,
    checkRuns: database.checkRuns.map((run) =>
      run.id === failureBRunId
        ? { ...run, completedAt: "2026-07-13T11:00:01.000Z", createdAt: "2026-07-13T11:00:01.000Z" }
        : run
    ),
    issues: database.issues.map((issue) =>
      issue.checkId === database.checks[0].id ? { ...issue, updatedAt: "2026-07-13T11:00:01.000Z" } : issue
    ),
  }

  const priorIssue = database.issues.find((issue) => issue.id === priorIssueId)
  const currentIssue = database.issues.find((issue) => issue.dedupeKey !== priorDedupeKey)
  assert.ok(priorIssue)
  assert.ok(currentIssue)
  assert.equal(database.issues.length, 2)
  assert.equal(priorIssue.status, "open")
  assert.equal(priorIssue.occurrenceCount, 1)
  assert.equal(priorIssue.repairRecordedAt, null)
  assert.equal(priorIssue.resolvedAt, null)
  assert.equal(priorIssue.verificationRunId, null)
  assert.equal(currentIssue.status, "open")
  assert.equal(currentIssue.checkRunId, failureBRunId)

  try {
    await syncCoreDatabaseToSupabase(database, [agency.id])
    const persistedIssues = harness.rows("issues")
    assert.equal(persistedIssues.length, 2)
    assert.equal(persistedIssues.every((issue) => issue.status === "open"), true)
    assert.equal(persistedIssues.find((issue) => issue.id === priorIssueId)?.verification_run_id, null)
    assert.equal(persistedIssues.some((issue) => issue.check_run_id === failureBRunId), true)
  } finally {
    harness.restore()
  }
})

function installSupabaseHarness(options: { enforceIssueVerificationTruth?: boolean } = {}) {
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const originalAuthMode = process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE
  const store = new Map<string, Record<string, unknown>[]>()
  const calls: Array<{
    method: string
    table: string
    pathname: string
    searchParams: URLSearchParams
    headers: Record<string, string>
    body: unknown
  }> = []
  const localStorage = createMemoryStorage()

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://maintainflow.supabase.test"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key"
  delete process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE
  localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: Date.now() + 3600_000,
    user: { id: user.id, email: user.email },
  }))
  Object.defineProperty(globalThis, "window", {
    value: { localStorage },
    configurable: true,
  })
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(String(url), "http://localhost")
    const isLegacyCoreSync = requestUrl.pathname === "/api/legacy-core-sync"
    const table = isLegacyCoreSync ? "legacy-core-sync" : requestUrl.pathname.split("/").at(-1) ?? ""
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const requestHeaders = headersToRecord(init?.headers)
    calls.push({
      method,
      table,
      pathname: requestUrl.pathname,
      searchParams: requestUrl.searchParams,
      headers: requestHeaders,
      body,
    })

    if (isLegacyCoreSync) {
      if (method !== "POST") return jsonResponse({ error: { message: "Unsupported method" } }, 405)
      if (
        requestHeaders.Authorization !== "Bearer access-token"
        || requestHeaders["X-MaintainFlow-Workspace-Id"] !== String(body?.creates?.[0]?.agency_id ?? body?.updates?.[0]?.row?.agency_id)
      ) {
        return jsonResponse({ error: { message: "Workspace access denied." } }, 403)
      }
      return applyLegacyCoreSyncHarness(store, body)
    }

    if (method === "GET") {
      return jsonResponse(selectRows(store.get(table) ?? [], requestUrl.searchParams))
    }

    if (method === "POST") {
      const rows = Array.isArray(body) ? body : [body]
      if (
        table === "issues" &&
        options.enforceIssueVerificationTruth &&
        rows.some((row) => resolvedIssueContradictsLatestRun(row, store.get("check_runs") ?? []))
      ) {
        return jsonResponse({ message: "The latest non-skipped run recorded after the repair must still be healthy." }, 400)
      }
      const existing = store.get(table) ?? []
      const ignoreDuplicates = requestHeaders.Prefer?.includes("resolution=ignore-duplicates") ?? false
      for (const row of rows) {
        if (!row?.id) continue
        const index = existing.findIndex((item) => item.id === row.id)
        if (index >= 0) {
          if (!ignoreDuplicates) existing[index] = { ...existing[index], ...row }
        } else {
          existing.push(row)
        }
      }
      store.set(table, existing)
      return jsonResponse(requestHeaders.Prefer?.includes("return=representation") ? rows : null)
    }

    if (method === "PATCH") {
      const existing = store.get(table) ?? []
      const matching = new Set(selectRows(existing, requestUrl.searchParams))
      const updatedRows: Record<string, unknown>[] = []
      store.set(table, existing.map((row) => {
        if (!matching.has(row)) return row
        const updated = { ...row, ...(body as object) }
        updatedRows.push(updated)
        return updated
      }))
      return jsonResponse(requestHeaders.Prefer?.includes("return=representation") ? updatedRows : null)
    }

    return jsonResponse({ message: "Unsupported method" }, 405)
  }) as typeof fetch

  return {
    calls,
    rows(table: string) {
      return store.get(table) ?? []
    },
    seed(table: string, rows: Record<string, unknown>[]) {
      store.set(table, rows)
    },
    patchRow(table: string, id: unknown, patch: Record<string, unknown>) {
      const rows = store.get(table) ?? []
      store.set(table, rows.map((row) => row.id === id ? { ...row, ...patch } : row))
    },
    clearCalls() {
      calls.length = 0
    },
    restore() {
      globalThis.fetch = originalFetch
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
      })
      restoreEnv("NEXT_PUBLIC_SUPABASE_URL", originalUrl)
      restoreEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", originalAnonKey)
      restoreEnv("NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE", originalAuthMode)
    },
  }
}

const legacyClientMutableKeys = [
  "name",
  "slug",
  "website",
  "owner_user_id",
  "report_recipient_email",
  "report_cadence",
  "notes",
  "archived_at",
] as const

const legacyWorkflowMutableKeys = [
  "name",
  "type",
  "environment",
  "endpoint_url",
  "method",
  "auth_type",
  "encrypted_auth_config",
  "request_body",
  "expected_status",
  "timeout_seconds",
  "max_latency_ms",
  "frequency_minutes",
  "retries",
  "report_included",
  "store_raw_response",
  "archived_at",
] as const

function applyLegacyCoreSyncHarness(
  store: Map<string, Record<string, unknown>[]>,
  request: {
    table?: string
    creates?: Array<Record<string, unknown>>
    updates?: Array<{ expectedUpdatedAt?: string; row?: Record<string, unknown> }>
  }
) {
  if (request.table !== "clients" && request.table !== "workflows") {
    return jsonResponse({ ok: false, error: { message: "Invalid legacy synchronization request." } }, 400)
  }
  const table = request.table
  const mutableKeys = table === "clients" ? legacyClientMutableKeys : legacyWorkflowMutableKeys
  const rows = store.get(table) ?? []

  for (const requested of request.creates ?? []) {
    const existing = rows.find((row) => row.id === requested.id)
    const expected = table === "clients"
      ? { agency_id: requested.agency_id, project_kind: "client_site", ...pickKeys(requested, mutableKeys) }
      : {
          agency_id: requested.agency_id,
          client_id: requested.client_id,
          ...pickKeys(requested, mutableKeys),
          status: requested.archived_at ? "archived" : "pending",
          health_score: 0,
          last_check_run_at: null,
          journey_template: "legacy_endpoint",
          draft_definition_json: {},
          draft_revision: 0,
          paused_at: null,
          pause_reason: "",
        }
    if (existing) {
      if (!matchesProjection(existing, expected)) {
        return jsonResponse({ ok: false, error: { message: `The legacy ${table} identifier is already in use.` } }, 409)
      }
      continue
    }
    rows.push(table === "clients"
      ? { ...requested, project_kind: "client_site" }
      : {
          ...requested,
          status: requested.archived_at ? "archived" : "pending",
          health_score: 0,
          last_check_run_at: null,
          journey_template: "legacy_endpoint",
          draft_definition_json: {},
          draft_revision: 0,
          paused_at: null,
          pause_reason: "",
        })
  }

  for (const update of request.updates ?? []) {
    const requested = update.row ?? {}
    const index = rows.findIndex((row) => row.id === requested.id && row.agency_id === requested.agency_id)
    if (index < 0) {
      return jsonResponse({ ok: false, error: { message: `Legacy ${table} not found.` } }, 404)
    }
    const patch = pickKeys(requested, mutableKeys)
    if (String(rows[index].updated_at) !== update.expectedUpdatedAt) {
      if (matchesProjection(rows[index], patch)) continue
      return jsonResponse({ ok: false, error: { message: `${table} changed in another session. Reload and try again.` } }, 409)
    }
    rows[index] = { ...rows[index], ...patch, updated_at: requested.updated_at }
  }

  store.set(table, rows)
  return jsonResponse({
    ok: true,
    data: {
      table,
      created: (request.creates ?? []).map((row) => row.id),
      updated: (request.updates ?? []).map((update) => update.row?.id),
    },
  })
}

function pickKeys(
  row: Record<string, unknown>,
  keys: readonly string[]
) {
  return Object.fromEntries(keys.map((key) => [key, row[key]]))
}

function matchesProjection(row: Record<string, unknown>, projection: Record<string, unknown>) {
  return Object.entries(projection).every(
    ([key, value]) => JSON.stringify(row[key] ?? null) === JSON.stringify(value ?? null)
  )
}

function resolvedIssueContradictsLatestRun(
  issue: Record<string, unknown>,
  checkRuns: Record<string, unknown>[]
) {
  if (issue.status !== "resolved") return false
  const repairRecordedAt = new Date(String(issue.repair_recorded_at ?? "")).getTime()
  const latestRun = checkRuns
    .filter((run) =>
      run.agency_id === issue.agency_id &&
      run.client_id === issue.client_id &&
      run.workflow_id === issue.workflow_id &&
      run.check_id === issue.check_id &&
      run.status !== "skipped" &&
      new Date(String(run.started_at ?? "")).getTime() > repairRecordedAt
    )
    .sort((left, right) =>
      new Date(String(right.started_at ?? "")).getTime() - new Date(String(left.started_at ?? "")).getTime()
    )[0]

  return latestRun?.status !== "healthy"
}

function failedResult(): EndpointTestResult {
  return {
    status: "failed",
    statusCode: 500,
    latencyMs: 500,
    assertionResults: [],
    safeResponseSummary: "The endpoint returned an unexpected response.",
    errorMessage: "Expected 200 but received 500.",
  }
}

function selectRows(rows: Record<string, unknown>[], params: URLSearchParams) {
  let selected = rows
  for (const [key, value] of params.entries()) {
    if (key === "select" || key === "order") continue
    if (value.startsWith("eq.")) {
      const expected = value.slice(3)
      selected = selected.filter((row) => String(row[key]) === expected)
    }
    if (value.startsWith("in.(") && value.endsWith(")")) {
      const expected = new Set(value.slice(4, -1).split(","))
      selected = selected.filter((row) => expected.has(String(row[key])))
    }
  }
    return selected
}

function headersToRecord(headers: HeadersInit | undefined) {
  if (!headers) return {}
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return headers
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(payload === null ? "" : JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function postgrestTimestamp(value: string) {
  return value.replace(/Z$/, "+00:00")
}

function postgrestMicrosecondTimestamp(value: string) {
  return value.replace(/\.(\d{3})Z$/, ".$1456+00:00")
}

function agencyToRow(agency: {
  id: string
  name: string
  slug: string
  plan: string
  trialEndsAt?: string | null
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  reportSenderName: string
  reportSenderEmail: string
  createdAt: string
  updatedAt: string
}) {
  return {
    id: agency.id,
    name: agency.name,
    slug: agency.slug,
    plan: agency.plan,
    trial_ends_at: agency.trialEndsAt ?? null,
    stripe_customer_id: agency.stripeCustomerId ?? null,
    stripe_subscription_id: agency.stripeSubscriptionId ?? null,
    report_sender_name: agency.reportSenderName,
    report_sender_email: agency.reportSenderEmail,
    created_at: agency.createdAt,
    updated_at: agency.updatedAt,
  }
}

function clientToRow(client: {
  id: string
  agencyId: string
  name: string
  slug: string
  website: string
  ownerUserId: string
  reportRecipientEmail: string
  reportCadence: string
  notes: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}) {
  return {
    id: client.id,
    agency_id: client.agencyId,
    name: client.name,
    slug: client.slug,
    website: client.website,
    owner_user_id: client.ownerUserId || null,
    report_recipient_email: client.reportRecipientEmail || null,
    report_cadence: client.reportCadence,
    notes: client.notes,
    archived_at: client.archivedAt,
    created_at: client.createdAt,
    updated_at: client.updatedAt,
  }
}

function membershipToRow(membership: { id: string; agencyId: string; userId: string; role: string; createdAt: string }) {
  return {
    id: membership.id,
    agency_id: membership.agencyId,
    user_id: membership.userId,
    role: membership.role,
    created_at: membership.createdAt,
  }
}
