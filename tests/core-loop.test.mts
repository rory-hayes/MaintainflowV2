import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { calculateCheckStatus, evaluateAssertions } from "../src/lib/core/assertions.ts"
import { runEndpointTest } from "../src/lib/core/check-runner.ts"
import { normalizeEndpointResult } from "../src/lib/core/plugins/endpoint-result.ts"
import { parseCurlCommand } from "../src/lib/core/curl.ts"
import { validateEndpointUrlForRequest } from "../src/lib/core/endpoint-safety.server.ts"
import { acceptedEndpointApiResult } from "../src/lib/core/endpoint-api-result.ts"
import { detectPlatformImport } from "../src/lib/core/imports.ts"
import { createFixedWindowRateLimiter } from "../src/lib/core/rate-limit.ts"
import { createReportPdfStoragePath, isExpectedReportPdfStoragePath } from "../src/lib/supabase/report-storage-path.ts"
import { currentMonthToDate, dateInputValue, isTimestampInReportPeriod, validateReportPeriod } from "../src/lib/core/report-period.ts"
import { hasSensitiveWorkflowHeaders, sanitizeStoredWorkflowHeaders, scheduledHeadersFromWorkflowConfig } from "../src/lib/core/workflow-auth.ts"
import { resolveWorkspaceReadiness } from "../src/lib/core/workspace-readiness.ts"
import {
  validateWorkflowClientStep,
  validateWorkflowConfigureStep,
  workflowWizardInitialDraft,
  workflowWizardPlaceholders,
} from "../src/lib/core/workflow-wizard.ts"
import {
  addIssueNote,
  activationChecklist,
  createPendingWorkflow,
  createAgencyWorkspace,
  createClientRecord,
  createReportDownload,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  generateReportRecord,
  isActivationChecklistComplete,
  recordIssueRepair,
  runWorkflowCheck,
  scopedData,
  recordScheduledCheckJob,
  selectDueChecks,
  updateIssueRecord,
  updateReportNarrative,
} from "../src/lib/core/local-store.ts"
import { safeResponseSummary, validateEndpointUrl } from "../src/lib/core/security.ts"
import type { EndpointTestResult } from "../src/lib/core/types.ts"

const user = {
  id: "user_1",
  name: "Alex Morgan",
  email: "alex@maintainflow.test",
  company: "Northstar Automations",
  role: "Agency Founder",
}

test("parses endpoint details from cURL", () => {
  const parsed = parseCurlCommand(
    "curl -X POST https://api.example.com/webhook -H 'Authorization: Bearer secret' -H 'Content-Type: application/json' --data '{\"ok\":true}'"
  )

  assert.equal(parsed.url, "https://api.example.com/webhook")
  assert.equal(parsed.method, "POST")
  assert.equal(parsed.headers.Authorization, "Bearer secret")
  assert.equal(parsed.contentType, "application/json")
  assert.equal(parsed.body, "{\"ok\":true}")
})

test("blocks unsafe endpoint URLs", () => {
  assert.equal(validateEndpointUrl("http://localhost:3000").ok, false)
  assert.equal(validateEndpointUrl("http://127.0.0.1:54321").ok, false)
  assert.equal(validateEndpointUrl("http://10.0.0.1").ok, false)
  assert.equal(validateEndpointUrl("file:///etc/passwd").ok, false)
  assert.equal(validateEndpointUrl("https://token@example.com/path").ok, false)
  assert.equal(validateEndpointUrl("https://api.example.com/path").ok, true)
})

test("stored response summaries never copy response secrets or personal data", () => {
  const body = JSON.stringify({
    access_token: "sk_live_secret",
    api_key: "key_secret",
    password: "hunter2",
    email: "person@example.com",
  })
  const summary = safeResponseSummary(body, "application/json")

  assert.match(summary, /JSON response received/)
  assert.match(summary, /body content was not stored/)
  assert.doesNotMatch(summary, /sk_live|key_secret|hunter2|person@example\.com/)
})

test("assertion and normalized evidence never retain response content or configured secrets", () => {
  const secret = "sk_live_assertion_secret"
  const email = "private.person@example.com"
  const assertionResults = evaluateAssertions(
    [
      { id: "secret", type: "text_contains", expected: secret, enabled: true },
      { id: "email", type: "json_field_equals", path: "email", expected: "different", enabled: true },
    ],
    {
      responseText: JSON.stringify({ token: secret, email }),
      statusCode: 200,
      latencyMs: 120,
    }
  )
  const normalized = normalizeEndpointResult({
    status: "degraded",
    statusCode: 200,
    latencyMs: 120,
    assertionResults,
    safeResponseSummary: "JSON response received (82 bytes); body content was not stored.",
    errorMessage: "",
  }, {
    url: `https://api.example.test/check?token=${secret}`,
    expectedStatus: 200,
    maxLatencyMs: 5_000,
  })
  const persistedShape = JSON.stringify({ assertionResults, normalized })

  assert.deepEqual(assertionResults.map((item) => Object.keys(item).sort()), [
    ["id", "label", "passed"],
    ["id", "label", "passed", "reason"],
  ])
  assert.doesNotMatch(persistedShape, /sk_live_assertion_secret|private\.person@example\.com/)
  assert.doesNotMatch(persistedShape, /api\.example\.test|"actual"|"expected"|rawResult/)
})

test("endpoint errors do not persist an origin-controlled HTTP reason phrase", async () => {
  const result = await runEndpointTest(
    {
      url: "https://api.example.test/health",
      method: "GET",
      headers: {},
      body: "",
      expectedStatus: 200,
      timeoutSeconds: 10,
      maxLatencyMs: 5000,
      assertions: [],
    },
    {
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async () => new Response("", { status: 500, statusText: "person@example.com secret-token" }),
    }
  )

  assert.equal(result.errorMessage, "Expected HTTP 200 but received HTTP 500.")
  assert.doesNotMatch(result.errorMessage, /person@example|secret-token/)
})

test("401 and 429 endpoint API errors abort instead of becoming customer failures", () => {
  const apiError = (errorMessage: string): EndpointTestResult => ({
    status: "skipped",
    statusCode: null,
    latencyMs: null,
    assertionResults: [],
    safeResponseSummary: "No response body was stored.",
    errorMessage,
  })

  assert.throws(() => acceptedEndpointApiResult(false, apiError("Sign in before testing an endpoint.")), /Sign in/)
  assert.throws(() => acceptedEndpointApiResult(false, apiError("Too many endpoint tests.")), /Too many/)
})

test("workspace readiness blocks app actions until the agency is confirmed", () => {
  assert.deepEqual(
    resolveWorkspaceReadiness({
      authReady: true,
      hasUser: true,
      coreLoading: true,
      creatingAgency: false,
      hasAgency: false,
      pathname: "/workflows",
    }),
    {
      authLoading: false,
      workspacePending: true,
      workspaceReady: false,
      appActionsEnabled: false,
      shouldRedirectToOnboarding: false,
    }
  )

  assert.deepEqual(
    resolveWorkspaceReadiness({
      authReady: true,
      hasUser: true,
      coreLoading: false,
      creatingAgency: true,
      hasAgency: false,
      pathname: "/onboarding",
    }),
    {
      authLoading: false,
      workspacePending: true,
      workspaceReady: false,
      appActionsEnabled: false,
      shouldRedirectToOnboarding: false,
    }
  )

  assert.equal(
    resolveWorkspaceReadiness({
      authReady: true,
      hasUser: true,
      coreLoading: false,
      creatingAgency: false,
      hasAgency: false,
      pathname: "/workflows",
    }).shouldRedirectToOnboarding,
    true
  )

  assert.equal(
    resolveWorkspaceReadiness({
      authReady: true,
      hasUser: true,
      coreLoading: false,
      creatingAgency: false,
      hasAgency: true,
      pathname: "/workflows",
    }).appActionsEnabled,
    true
  )
})

test("new workspaces start on Free and enforce client/workflow limits", () => {
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]

  assert.equal(agency.plan, "free")

  database = createClientRecord(database, agency.id, user.id, {
    name: "Acme AI Systems",
    reportRecipientEmail: "ops@acme.example",
  })
  const client = database.clients[0]

  assert.throws(
    () => createClientRecord(database, agency.id, user.id, { name: "Second Client" }),
    /Free allows up to 1 active client/
  )

  const healthyResult: EndpointTestResult = {
    status: "healthy",
    statusCode: 200,
    latencyMs: 100,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":true}",
    errorMessage: "",
  }

  for (let index = 1; index <= 3; index += 1) {
    database = createWorkflowWithFirstRun(database, agency.id, user.id, {
      clientId: client.id,
      name: `Client workflow ${index}`,
      endpointUrl: `https://status.example.com/healthy-${index}`,
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
      assertions: [],
    }, healthyResult)
  }

  assert.equal(database.workflows.filter((workflow) => workflow.agencyId === agency.id).length, 3)
  assert.throws(
    () => createPendingWorkflow(database, agency.id, user.id, {
      clientId: client.id,
      name: "Fourth workflow",
      endpointUrl: "",
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
      assertions: [],
      pendingReason: "Needs production URL",
    }),
    /Free allows up to 3 active workflows/
  )

  const reportPeriod = { clientId: client.id, ...currentMonthToDate() }
  database = generateReportRecord(database, agency, user.id, reportPeriod)

  assert.throws(
    () => generateReportRecord(database, agency, user.id, reportPeriod),
    /Free allows up to 1 report per month/
  )
})

test("empty report attempts preserve quota and healthy setup activates without an issue", () => {
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme AI Systems" })
  const client = database.clients[0]
  const reportPeriod = { clientId: client.id, ...currentMonthToDate() }

  assert.throws(
    () => generateReportRecord(database, agency, user.id, reportPeriod),
    /Add at least one active, report-included workflow/
  )
  assert.equal(database.reports.length, 0)

  database = createPendingWorkflow(database, agency.id, user.id, {
    clientId: client.id,
    name: "Pending production endpoint",
    endpointUrl: "",
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
    assertions: [],
    pendingReason: "Production endpoint is not available yet.",
  })
  assert.throws(
    () => generateReportRecord(database, agency, user.id, reportPeriod),
    /Run at least one report-included workflow check in the selected period/
  )
  assert.equal(database.reports.length, 0)

  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Healthy production endpoint",
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
    assertions: [],
  }, {
    status: "healthy",
    statusCode: 200,
    latencyMs: 100,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":true}",
    errorMessage: "",
  })
  database = generateReportRecord(database, agency, user.id, reportPeriod)

  assert.equal(database.reports.length, 1)
  const checklist = activationChecklist(database, agency.id)
  assert.equal(checklist.issueCreated, false)
  assert.equal(checklist.issueResolved, false)
  assert.equal(isActivationChecklistComplete(checklist), true)
  assert.equal(isActivationChecklistComplete({ ...checklist, reportGenerated: false }), false)
  assert.throws(
    () => generateReportRecord(database, agency, user.id, reportPeriod),
    /Free allows up to 1 report per month/
  )
})

test("blocks endpoint hostnames that resolve to internal addresses before fetch", async () => {
  let fetchCalled = false
  const result = await runEndpointTest(
    {
      url: "https://internal.example.test/health",
      method: "GET",
      headers: {},
      body: "",
      expectedStatus: 200,
      timeoutSeconds: 10,
      maxLatencyMs: 5000,
      assertions: [],
    },
    {
      resolveHostname: async () => ["10.0.0.5"],
      fetchImpl: async () => {
        fetchCalled = true
        return new Response("should not fetch")
      },
    }
  )

  assert.equal(fetchCalled, false)
  assert.equal(result.status, "skipped")
  assert.match(result.errorMessage, /blocked internal address \(10\.0\.0\.5\)/)
})

test("blocks mapped-IPv4 hex and multicast IPv6 targets", async () => {
  for (const address of ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "ff02::1"]) {
    const resolved = await validateEndpointUrlForRequest("https://api.example.test/health", async () => [address])
    assert.equal(resolved.ok, false, `${address} must be blocked when returned by DNS`)
  }

  const literal = await validateEndpointUrlForRequest("http://[::ffff:7f00:1]/health")
  assert.equal(literal.ok, false)
})

test("allows endpoint hostnames that resolve to public addresses", async () => {
  const result = await validateEndpointUrlForRequest("https://api.example.test/health", async () => ["93.184.216.34"])

  assert.equal(result.ok, true)
})

test("real endpoint execution uses the already validated address instead of resolving again", async () => {
  let resolverCalls = 0
  const result = await runEndpointTest(
    {
      url: "https://rebind.example.test/health",
      method: "GET",
      headers: {},
      body: "",
      expectedStatus: 200,
      timeoutSeconds: 10,
      maxLatencyMs: 5000,
      assertions: [],
    },
    {
      resolveHostname: async () => {
        resolverCalls += 1
        return ["93.184.216.34"]
      },
      pinnedFetchImpl: async (url, validatedAddresses, init) => {
        assert.equal(url.hostname, "rebind.example.test")
        assert.deepEqual(validatedAddresses, ["93.184.216.34"])
        assert.equal(new Headers(init.headers).has("host"), false)
        return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } })
      },
    }
  )

  assert.equal(resolverCalls, 1)
  assert.equal(result.status, "healthy")
})

test("blocks redirects that resolve to internal addresses", async () => {
  const result = await runEndpointTest(
    {
      url: "https://api.example.test/health",
      method: "GET",
      headers: {},
      body: "",
      expectedStatus: 200,
      timeoutSeconds: 10,
      maxLatencyMs: 5000,
      assertions: [],
    },
    {
      resolveHostname: async (hostname) => (hostname === "api.example.test" ? ["93.184.216.34"] : ["169.254.169.254"]),
      fetchImpl: async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://metadata.example.test/latest/meta-data" },
        }),
    }
  )

  assert.equal(result.status, "skipped")
  assert.match(result.errorMessage, /Redirect blocked: Endpoint hostname resolves to a blocked internal address/)
})

test("inconclusive runner evidence is stored without creating a customer issue and remains rerunnable", () => {
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, { name: "Northstar", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme" })
  const client = database.clients[0]
  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Invoice journey",
    endpointUrl: "https://api.example.test/health",
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
    assertions: [],
  }, {
    status: "skipped",
    statusCode: null,
    latencyMs: null,
    assertionResults: [],
    safeResponseSummary: "No response body was stored.",
    errorMessage: "The runner could not resolve the endpoint host.",
  })

  const dueAt = "2026-07-13T12:00:00.000Z"
  database = {
    ...database,
    checks: database.checks.map((check) => ({ ...check, nextRunAt: dueAt })),
  }

  assert.equal(database.checkRuns[0].status, "skipped")
  assert.equal(database.issues.length, 0)
  assert.equal(database.checks[0].pendingSetup, false)
  assert.equal(selectDueChecks(database, agency.id, dueAt).length, 1)
})

test("rate limits endpoint test attempts per scoped key", () => {
  let now = 1_000
  const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 1_000, now: () => now })

  assert.equal(limiter.check("agency:user").allowed, true)
  assert.equal(limiter.check("agency:user").allowed, true)
  assert.equal(limiter.check("agency:user").allowed, false)
  assert.equal(limiter.check("other-agency:user").allowed, true)

  now = 2_001
  assert.equal(limiter.check("agency:user").allowed, true)
})

test("evaluates assertions and degraded status", () => {
  const assertionResults = evaluateAssertions(
    [
      { id: "exists", type: "response_exists", enabled: true },
      { id: "field", type: "json_field_equals", path: "status", expected: "ok", enabled: true },
    ],
    {
      responseText: JSON.stringify({ status: "ok" }),
      statusCode: 200,
      latencyMs: 6500,
    }
  )

  assert.equal(assertionResults.every((result) => result.passed), true)
  assert.equal(
    calculateCheckStatus({
      expectedStatus: 200,
      statusCode: 200,
      latencyMs: 6500,
      maxLatencyMs: 5000,
      assertionResults,
      errorMessage: "",
    }),
    "degraded"
  )
})

test("core loop stores run, dedupes issue, resolves issue, and generates selected-client report", () => {
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  database = {
    ...database,
    agencies: database.agencies.map((agency) => ({
      ...agency,
      plan: "growth",
      complimentaryEntitlement: true,
      complimentaryEntitlementReason: "Core-loop integration fixture",
    })),
  }
  const agency = database.agencies[0]

  database = createClientRecord(database, agency.id, user.id, {
    name: "Acme AI Systems",
    reportRecipientEmail: "ops@acme.example",
  })
  database = createClientRecord(database, agency.id, user.id, {
    name: "Other Client",
    reportRecipientEmail: "ops@other.example",
  })

  const client = database.clients.find((item) => item.name === "Acme AI Systems")!
  const failedResult: EndpointTestResult = {
    status: "failed",
    statusCode: 500,
    latencyMs: 900,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":false}",
    errorMessage: "Expected 200 but received 500.",
  }

  database = createWorkflowWithFirstRun(
    database,
    agency.id,
    user.id,
    {
      clientId: client.id,
      name: "Invoice intake webhook",
      endpointUrl: "https://status.example.com/failed",
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
      assertions: [{ id: "ok-field", type: "json_field_exists", path: "ok", enabled: true }],
    },
    failedResult
  )

  const workflow = database.workflows[0]
  assert.equal(database.checks.length, 1)
  assert.equal(database.checks[0].assertions[0].id, "ok-field")
  assert.equal(database.checkRuns.length, 1)
  assert.equal(database.issues.length, 1)

  database = addIssueNote(database, agency.id, user.id, database.issues[0].id, "Investigating webhook retry behavior.", false)
  database = updateIssueRecord(database, agency.id, user.id, database.issues[0].id, { ownerUserId: "user_2" })
  assert.equal(database.issueNotes[0].reportSafe, false)
  assert.equal(database.issues[0].ownerUserId, "user_2")

  database = runWorkflowCheck(database, agency.id, user.id, workflow.id, database.checks[0].id, failedResult)
  assert.equal(database.checkRuns.length, 2)
  assert.equal(database.issues.length, 1)
  assert.equal(database.issues[0].occurrenceCount, 2)

  database = recordIssueRepair(database, agency.id, user.id, database.issues[0].id, "Rotated credentials; recovery now awaits a passing rerun.")
  assert.equal(database.issues[0].status, "in_review")
  assert.equal(database.issueNotes.length, 2)
  database = runWorkflowCheck(database, agency.id, user.id, workflow.id, database.checks[0].id, {
    status: "healthy",
    statusCode: 200,
    latencyMs: 180,
    assertionResults: [],
    safeResponseSummary: "The monitored endpoint returned the expected healthy response.",
    errorMessage: "",
  }, "manual_run", new Date(Date.now() + 1_000).toISOString())
  assert.equal(database.issues[0].status, "resolved")
  assert.equal(database.issues[0].verificationRunId, database.checkRuns[0].id)

  const reportPeriod = currentMonthToDate()
  database = generateReportRecord(database, agency, user.id, {
    clientId: client.id,
    periodStart: reportPeriod.periodStart,
    periodEnd: reportPeriod.periodEnd,
  })
  assert.equal(database.reports.length, 1)
  assert.equal(database.reports[0].clientId, client.id)
  assert.equal(database.reports[0].metrics.checksRun, 3)
  assert.equal(database.reports[0].metrics.issuesResolved, 1)
  assert.equal(database.reportItems.some((item) => item.reportId === database.reports[0].id && item.clientId === client.id), true)

  database = createReportDownload(database, agency, user.id, database.reports[0].id)
  assert.equal(database.reports[0].readiness.pdfGenerated, true)
  assert.equal(database.reports[0].status, "ready")
  assert.match(database.reports[0].pdfDataUrl ?? "", /^data:application\/pdf;base64,/)
  assert.equal(database.reports[0].pdfStoragePath, null)
  const pdfText = decodePdfDataUrl(database.reports[0].pdfDataUrl)
  assert.match(pdfText, /Maintain Flow/)
  assert.match(pdfText, /Client Report/)
  assert.match(pdfText, /Performance Snapshot/)
  assert.match(pdfText, /Executive Summary/)
  assert.match(pdfText, /Evidence Log/)
  assert.match(pdfText, /Invoice intake webhook/)

  database = updateReportNarrative(database, agency, user.id, database.reports[0].id, "Too short.")
  assert.equal(database.reports[0].status, "draft")
  assert.equal(database.reports[0].readiness.narrativeComplete, false)
  assert.equal(database.reports[0].readiness.pdfGenerated, false)
  assert.equal(database.reports[0].pdfDataUrl, null)
  assert.equal(database.reports[0].pdfStoragePath, null)

  database = updateReportNarrative(
    database,
    agency,
    user.id,
    database.reports[0].id,
    "This client-safe draft explains the monitored workflows, check volume, resolved issues, readiness state, and next maintenance recommendations for the selected reporting period. Rotated credentials; recovery now awaits a passing rerun."
  )
  assert.equal(database.reports[0].status, "ready")
  assert.equal(database.reports[0].readiness.narrativeComplete, true)

  const scoped = scopedData(database, agency.id)
  assert.equal(scoped.clients.length, 2)
  assert.equal(scoped.memberships.length, 1)
  assert.equal(scoped.reports[0].clientId, client.id)
  assert.equal(scoped.reportItems.length > 0, true)
})

test("saved monitors reject all custom headers and scrub legacy header material", () => {
  assert.equal(hasSensitiveWorkflowHeaders({ Authorization: "Bearer secret" }), true)
  assert.equal(hasSensitiveWorkflowHeaders({ "Content-Type": "application/json", Accept: "application/json" }), true)

  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, {
    name: "Acme AI Systems",
    reportRecipientEmail: "ops@acme.example",
  })

  assert.throws(() => createWorkflowWithFirstRun(
    database, agency.id, user.id, {
      clientId: database.clients[0].id,
      name: "Authenticated health endpoint",
      endpointUrl: "https://api.example.com/health",
      method: "GET",
      headers: {
        Authorization: "Bearer production-secret",
        "X-Client-Health": "public-health-token",
        "X-Auth-Token": "custom-auth-secret",
        "X-Amz-Security-Token": "aws-session-secret",
        ApiKey: "compact-api-secret",
        "Content-Type": "application/json",
      },
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
      assertions: [],
    },
    {
      status: "healthy",
      statusCode: 200,
      latencyMs: 120,
      assertionResults: [],
      safeResponseSummary: "OK",
      errorMessage: "",
    })
  , /Custom request headers cannot be stored/)
  assert.equal(database.workflows.length, 0)
  assert.deepEqual(
    sanitizeStoredWorkflowHeaders([{ key: "X-Secret", valuePreview: "legacy-plaintext-secret", sensitive: false }]),
    []
  )
  assert.deepEqual(
    scheduledHeadersFromWorkflowConfig({
      headers: [{ key: "X-Access-Token", valuePreview: "legacy-plaintext-secret", sensitive: false }],
    }),
    {}
  )
  const hookSource = readFileSync("src/hooks/use-core-loop.ts", "utf8")
  assert.equal((hookSource.match(/endpointInputFromSavedCheck\(\{/g) ?? []).length, 2)
  assert.match(hookSource, /configJson: check\.configJson[\s\S]*?assertions: check\.assertions[\s\S]*?encryptedAuthConfig: \{ headers: workflow\.headers \}/)
  assert.doesNotMatch(hookSource, /scheduledHeadersFromWorkflowConfig/)
  assert.match(hookSource, /acceptedEndpointApiResult\(response\.ok, result\)/)
})

test("report PDF storage paths are scoped to the report agency, report id, and snapshot", () => {
  const path = createReportPdfStoragePath("agency-123", "report-456", 3)

  assert.equal(path, "agency-123/reports/report-456/snapshot-3.pdf")
  assert.equal(isExpectedReportPdfStoragePath(path, "agency-123", "report-456", 3), true)
  assert.equal(isExpectedReportPdfStoragePath(path, "agency-123", "report-456", 2), false)
  assert.equal(isExpectedReportPdfStoragePath("other-agency/reports/report-456/snapshot-3.pdf", "agency-123", "report-456", 3), false)
})

test("report defaults use current UTC month-to-date and reject future period ends", () => {
  const today = new Date("2026-06-24T23:30:00.000Z")
  const period = currentMonthToDate(today)

  assert.deepEqual(period, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-24",
  })
  assert.equal(dateInputValue(today), "2026-06-24")
  assert.equal(validateReportPeriod(period, "2026-06-24"), null)
  assert.deepEqual(validateReportPeriod({ periodStart: "2026-06-01", periodEnd: "2026-06-30" }, "2026-06-24"), {
    field: "periodEnd",
    message: "Period end cannot be in the future.",
  })
  assert.deepEqual(validateReportPeriod({ periodStart: "2026-06-25", periodEnd: "2026-06-24" }, "2026-06-24"), {
    field: "periodStart",
    message: "Period start must be before period end.",
  })
  assert.deepEqual(validateReportPeriod({ periodStart: "2026-05-01", periodEnd: "2026-05-31" }, "2026-06-24"), {
    field: "periodStart",
    message: "Reports can currently be generated only for the current UTC month-to-date. Historical rebuilds require audit history.",
  })
  assert.deepEqual(validateReportPeriod({ periodStart: "2026-06-01", periodEnd: "2026-06-10" }, "2026-06-24"), {
    field: "periodEnd",
    message: "Reports can currently be generated only for the current UTC month-to-date. Historical rebuilds require audit history.",
  })
})

test("report-period inclusion uses the same UTC date at every runtime timezone", () => {
  const period = { periodStart: "2026-07-01", periodEnd: "2026-07-01" }

  assert.equal(isTimestampInReportPeriod("2026-06-30T23:59:59.999Z", period), false)
  assert.equal(isTimestampInReportPeriod("2026-07-01T00:00:00.000Z", period), true)
  assert.equal(isTimestampInReportPeriod("2026-07-01T23:59:59.999Z", period), true)
  assert.equal(isTimestampInReportPeriod("2026-07-02T00:00:00.000Z", period), false)
})

test("reports include check runs and issues through the selected period end date", () => {
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, {
    name: "Same Day Client",
    reportRecipientEmail: "ops@sameday.example",
  })
  const client = database.clients[0]
  const failedResult: EndpointTestResult = {
    status: "failed",
    statusCode: 500,
    latencyMs: 400,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":false}",
    errorMessage: "Expected 200 but received 500.",
  }

  database = createWorkflowWithFirstRun(
    database,
    agency.id,
    user.id,
    {
      clientId: client.id,
      name: "Same day failed workflow",
      endpointUrl: "https://status.example.com/failed",
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
    },
    failedResult
  )

  const reportPeriod = currentMonthToDate()
  const sameDayAfternoon = `${reportPeriod.periodEnd}T18:30:00.000Z`
  database = {
    ...database,
    checkRuns: database.checkRuns.map((run) => ({
      ...run,
      startedAt: sameDayAfternoon,
      completedAt: sameDayAfternoon,
      createdAt: sameDayAfternoon,
    })),
    issues: database.issues.map((issue) => ({
      ...issue,
      createdAt: sameDayAfternoon,
      updatedAt: sameDayAfternoon,
    })),
  }
  database = recordIssueRepair(database, agency.id, user.id, database.issues[0].id, "Repaired the same-day incident; awaiting verification.")
  database = {
    ...database,
    issues: database.issues.map((issue) =>
      issue.id === database.issues[0].id
        ? { ...issue, repairRecordedAt: `${reportPeriod.periodEnd}T18:45:00.000Z` }
        : issue
    ),
  }
  database = runWorkflowCheck(database, agency.id, user.id, database.workflows[0].id, database.checks[0].id, {
    status: "healthy",
    statusCode: 200,
    latencyMs: 160,
    assertionResults: [],
    safeResponseSummary: "The monitored endpoint returned the expected healthy response.",
    errorMessage: "",
  }, "manual_run", `${reportPeriod.periodEnd}T19:00:00.000Z`)
  const verificationRunId = database.checkRuns[0].id
  database = {
    ...database,
    checkRuns: database.checkRuns.map((run) =>
      run.id === verificationRunId
        ? { ...run, completedAt: `${reportPeriod.periodEnd}T19:00:01.000Z`, createdAt: `${reportPeriod.periodEnd}T19:00:01.000Z` }
        : run
    ),
    issues: database.issues.map((issue) =>
      issue.verificationRunId === verificationRunId
        ? { ...issue, resolvedAt: `${reportPeriod.periodEnd}T19:00:01.000Z`, updatedAt: `${reportPeriod.periodEnd}T19:00:01.000Z` }
        : issue
    ),
  }
  database = generateReportRecord(database, agency, user.id, {
    clientId: client.id,
    periodStart: reportPeriod.periodStart,
    periodEnd: reportPeriod.periodEnd,
  })

  assert.equal(database.reports[0].metrics.checksRun, 2)
  assert.equal(database.reports[0].metrics.issuesDetected, 1)
  assert.equal(database.reports[0].metrics.issuesResolved, 1)
  assert.equal(database.reports[0].readiness.checksAvailable, true)
  assert.match(database.reports[0].narrative, /1 issue was detected and 1 was resolved/)
  assert.equal(database.reportItems.some((item) => item.sourceType === "check_run"), true)
  assert.equal(database.reportItems.some((item) => item.sourceType === "issue"), true)
})

test("workflow wizard starts empty and validates the specific empty field", () => {
  assert.deepEqual(workflowWizardInitialDraft, {
    newClientName: "",
    workflowName: "",
    endpointUrl: "",
    curl: "",
    importPayload: "",
  })
  assert.equal(workflowWizardPlaceholders.endpointUrl, "https://status.client.com/customer-outcome-health")
  assert.equal(workflowWizardPlaceholders.curl, "curl https://status.client.com/customer-outcome-health")
  assert.doesNotMatch(workflowWizardPlaceholders.curl, /(?:^|\s)-(?:H|d|X)\b/)

  assert.deepEqual(validateWorkflowClientStep({ clientId: "new", newClientName: "" }), {
    field: "newClientName",
    message: "Client name is required.",
  })
  assert.equal(validateWorkflowClientStep({ clientId: "existing-client", newClientName: "" }), null)
  assert.deepEqual(validateWorkflowConfigureStep({
    setupMethod: "endpoint",
    workflowName: "",
    endpointUrl: "",
    curl: "",
    importPayload: "",
  }), {
    field: "workflowName",
    message: "Workflow name is required.",
  })
  assert.deepEqual(validateWorkflowConfigureStep({
    setupMethod: "endpoint",
    workflowName: "Lead enrichment",
    endpointUrl: "",
    curl: "",
    importPayload: "",
  }), {
    field: "endpointUrl",
    message: "Endpoint URL is required.",
  })
  assert.deepEqual(validateWorkflowConfigureStep({
    setupMethod: "curl",
    workflowName: "Lead enrichment",
    endpointUrl: "",
    curl: "",
    importPayload: "",
  }), {
    field: "curl",
    message: "cURL command is required.",
  })
  assert.equal(validateWorkflowConfigureStep({
    setupMethod: "curl",
    workflowName: "Lead enrichment",
    endpointUrl: "",
    curl: "curl https://api.client.com/health",
    importPayload: "",
  }), null)
  assert.deepEqual(validateWorkflowConfigureStep({
    setupMethod: "import",
    workflowName: "Lead enrichment",
    endpointUrl: "",
    curl: "",
    importPayload: "",
  }), {
    field: "importPayload",
    message: "Import payload is required.",
  })
})

test("scheduled check foundation selects due checks and records visible job runs", () => {
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme AI Systems" })
  const client = database.clients[0]
  const healthyResult: EndpointTestResult = {
    status: "healthy",
    statusCode: 200,
    latencyMs: 120,
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
  const check = database.checks[0]
  database = {
    ...database,
    checks: database.checks.map((item) =>
      item.id === check.id ? { ...item, nextRunAt: "2026-06-01T00:00:00.000Z" } : item
    ),
  }

  const due = selectDueChecks(database, agency.id, "2026-06-01T00:01:00.000Z")
  assert.equal(due.length, 1)
  database = recordScheduledCheckJob(database, agency.id, user.id, {
    startedAt: "2026-06-01T00:01:00.000Z",
    checksDue: due.length,
    attempts: [{ checkId: due[0].check.id, workflowId: due[0].workflow.id, result: healthyResult }],
  })

  assert.equal(database.checkJobRuns.length, 1)
  assert.equal(database.checkJobRuns[0].status, "success")
  assert.equal(database.checkJobRuns[0].checksRun, 1)
  assert.equal(database.checkRuns.length, 2)
  assert.notEqual(database.checks[0].nextRunAt, "2026-06-01T00:00:00.000Z")
})

test("scheduled check foundation does not persist empty zero-due job runs", () => {
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  const nextDatabase = recordScheduledCheckJob(database, agency.id, user.id, {
    startedAt: "2026-06-01T00:01:00.000Z",
    checksDue: 0,
    attempts: [],
  })

  assert.equal(nextDatabase, database)
  assert.equal(nextDatabase.checkJobRuns.length, 0)
})

test("internal or snoozed high-risk issues do not block client report readiness", () => {
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme AI Systems" })
  const client = database.clients[0]
  const failedResult: EndpointTestResult = {
    status: "failed",
    statusCode: 500,
    latencyMs: 900,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":false}",
    errorMessage: "Expected 200 but received 500.",
  }

  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Invoice intake webhook",
    endpointUrl: "https://status.example.com/failed",
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
  }, failedResult)
  database = updateIssueRecord(database, agency.id, user.id, database.issues[0].id, {
    status: "snoozed",
    reportable: false,
  })
  const reportPeriod = currentMonthToDate()
  database = generateReportRecord(database, agency, user.id, {
    clientId: client.id,
    periodStart: reportPeriod.periodStart,
    periodEnd: reportPeriod.periodEnd,
  })

  assert.equal(database.reports[0].metrics.issuesDetected, 0)
  assert.equal(database.reports[0].metrics.unresolvedHighRiskIssues, 0)
})

test("detects platform imports and saves pending workflow when no callable URL exists", () => {
  const imported = detectPlatformImport(JSON.stringify({ name: "Lead intake", nodes: [{ type: "n8n-nodes-base.webhook" }] }))
  assert.equal(imported.platform, "n8n")
  assert.equal(imported.pendingSetup, true)
  assert.match(imported.warnings[0], /no callable webhook URL/i)

  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme AI Systems" })
  const client = database.clients[0]
  database = createPendingWorkflow(database, agency.id, user.id, {
    clientId: client.id,
    name: imported.name,
    endpointUrl: imported.endpointUrl,
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
    type: "n8n",
    assertions: [{ id: "response-exists", type: "response_exists", enabled: true }],
    pendingReason: imported.warnings[0],
  })

  assert.equal(database.workflows[0].status, "pending")
  assert.equal(database.checks[0].enabled, false)
  assert.equal(database.checks[0].pendingSetup, true)
  assert.equal(database.checkRuns.length, 0)
})

function decodePdfDataUrl(dataUrl: string | null) {
  assert.ok(dataUrl)
  const base64 = dataUrl.split(",")[1]
  assert.ok(base64)
  return Buffer.from(base64, "base64").toString("latin1")
}
