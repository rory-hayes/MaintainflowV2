import assert from "node:assert/strict"
import test from "node:test"
import { runEndpointPluginTest, runEndpointTest } from "../src/lib/core/check-runner.ts"
import { getCheckPlugin, listCheckPlugins } from "../src/lib/core/plugins/registry.ts"
import { createReportViewModel } from "../src/lib/core/reports/report-view-model.ts"
import { scanUrlSuggestions } from "../src/lib/core/url-scan.ts"
import {
  createAgencyWorkspace,
  createClientRecord,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  generateReportRecord,
  recordIssueRepair,
  runWorkflowCheck,
} from "../src/lib/core/local-store.ts"
import { currentMonthToDate } from "../src/lib/core/report-period.ts"
import type { EndpointTestInput, EndpointTestResult } from "../src/lib/core/types.ts"

const user = {
  id: "user_1",
  name: "Alex Morgan",
  email: "alex@maintainflow.io",
  company: "Northstar Automations",
  role: "Agency Founder",
}

test("endpoint checks run through the plugin registry without changing endpoint behavior", async () => {
  const plugins = listCheckPlugins()
  assert.equal(plugins.some((plugin) => plugin.pluginId === "endpoint"), true)

  const input: EndpointTestInput = {
    url: "https://demo.maintainflow.test/healthy",
    method: "GET",
    headers: {},
    body: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5000,
    assertions: [{ id: "response-exists", type: "response_exists", enabled: true }],
  }
  const legacyResult = await runEndpointTest(input)
  const normalizedResult = await runEndpointPluginTest(input)

  assert.equal(legacyResult.status, "healthy")
  assert.equal(normalizedResult.status, "healthy")
  assert.equal(normalizedResult.evidence.pluginId, "endpoint")
  assert.equal(normalizedResult.assertionResults.length, 1)
})

test("endpoint plugin normalizes failed endpoint checks into unhealthy plugin results", async () => {
  const plugin = getCheckPlugin<EndpointTestInput, EndpointTestResult>("endpoint")
  const input = plugin.validateConfig({
    url: "https://demo.maintainflow.test/failed",
    method: "GET",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5000,
    assertions: [],
  })
  const result = await plugin.run(input)
  const normalized = plugin.normalizeResult(result, input)

  assert.equal(result.status, "failed")
  assert.equal(normalized.status, "unhealthy")
  assert.match(normalized.issueFingerprint, /^endpoint:/)
})

test("report view model maps generated reports into client-ready preview sections", () => {
  let database = emptyCoreDatabase()
  database = createAgencyWorkspace(database, user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, {
    name: "Acme AI Systems",
    website: "https://acme.example",
    reportRecipientEmail: "ops@acme.com",
  })
  const client = database.clients[0]
  const failedResult: EndpointTestResult = {
    status: "failed",
    statusCode: 500,
    latencyMs: 420,
    assertionResults: [],
    safeResponseSummary: "JSON response: {\"ok\":false}",
    errorMessage: "Expected 200 but received 500.",
  }

  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Invoice intake API",
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
    assertions: [],
  }, failedResult)
  database = recordIssueRepair(database, agency.id, user.id, database.issues[0].id, "Recovered the endpoint; a passing rerun will confirm it is safe for the next billing run.")
  database = runWorkflowCheck(database, agency.id, user.id, database.workflows[0].id, database.checks[0].id, {
    status: "healthy",
    statusCode: 200,
    latencyMs: 180,
    assertionResults: [],
    safeResponseSummary: "The endpoint returned the expected healthy response.",
    errorMessage: "",
  }, "manual_run", new Date(Date.now() + 1_000).toISOString())
  database = generateReportRecord(database, agency, user.id, { clientId: client.id, ...currentMonthToDate(new Date()) })

  const viewModel = createReportViewModel({ database, agency, report: database.reports[0] })

  assert.equal(viewModel.reportId, database.reports[0].id)
  assert.equal(viewModel.client.name, "Acme AI Systems")
  assert.equal(viewModel.scorecard.workflowsMonitored, 1)
  assert.equal(viewModel.workflowCoverage[0].name, "Invoice intake API")
  assert.equal(viewModel.checkRuns.length, 2)
  assert.equal(viewModel.resolvedIssues.length, 1)
  assert.match(viewModel.reportSafeNarrative, /Recovered the endpoint/)
  assert.equal(viewModel.evidenceItems.some((item) => item.sourceType === "recommendation"), true)
})

test("safe URL scan suggests homepage, detected key pages, and JSON health checks", async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = new URL(String(url))
    if (target.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(
      "<html><head><title>Acme Automation</title></head><body><a href='/pricing'>Pricing</a><a href='/contact'>Contact</a></body></html>",
      { status: 200, headers: { "Content-Type": "text/html" } }
    )
  }) as typeof fetch

  const result = await scanUrlSuggestions(
    {
      clientName: "Acme",
      websiteUrl: "https://www.acme.test",
      healthApiUrl: "https://api.acme.test/health",
    },
    {
      fetchImpl,
      resolveHostname: async () => ["93.184.216.34"],
    }
  )

  assert.equal(result.warnings.length, 0)
  assert.equal(result.suggestions.some((suggestion) => suggestion.label === "Homepage health"), true)
  assert.equal(result.suggestions.some((suggestion) => suggestion.label === "Pricing page health"), true)
  const api = result.suggestions.find((suggestion) => suggestion.label === "API or health endpoint")
  assert.ok(api)
  assert.equal(api.check.assertions.some((assertion) => assertion.type === "json_field_exists" && assertion.path === "ok"), true)
})

test("URL scan blocks unsafe hosts before making network requests", async () => {
  let fetchCalled = false
  const result = await scanUrlSuggestions(
    { clientName: "Unsafe", websiteUrl: "http://localhost:3000" },
    {
      fetchImpl: (async () => {
        fetchCalled = true
        return new Response("should not happen")
      }) as typeof fetch,
    }
  )

  assert.equal(fetchCalled, false)
  assert.equal(result.suggestions.length, 0)
  assert.match(result.warnings[0], /localhost/i)
})

test("accepted URL scan suggestions can become real workflow/check records", async () => {
  const result = await scanUrlSuggestions(
    { clientName: "Acme", websiteUrl: "https://www.acme.test" },
    {
      fetchImpl: (async () => new Response("<title>Acme Automation</title>", { status: 200 })) as typeof fetch,
      resolveHostname: async () => ["93.184.216.34"],
    }
  )
  const suggestion = result.suggestions[0]
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, { name: "Northstar Automations", slug: "northstar" })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Acme" })
  const client = database.clients[0]

  database = createWorkflowWithFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: suggestion.workflow.name,
    endpointUrl: suggestion.workflow.endpointUrl,
    method: suggestion.workflow.method,
    headers: {},
    requestBody: "",
    expectedStatus: suggestion.workflow.expectedStatus,
    timeoutSeconds: suggestion.workflow.timeoutSeconds,
    maxLatencyMs: suggestion.workflow.maxLatencyMs,
    frequencyMinutes: suggestion.workflow.frequencyMinutes,
    retries: 2,
    reportIncluded: true,
    storeRawResponse: false,
    environment: "production",
    type: "http_endpoint",
    assertions: suggestion.check.assertions,
  }, {
    status: "healthy",
    statusCode: 200,
    latencyMs: 120,
    assertionResults: [],
    safeResponseSummary: "HTML response: <title>Acme Automation</title>",
    errorMessage: "",
  })

  assert.equal(database.workflows[0].name, "Acme homepage")
  assert.equal(database.checks[0].pluginId, "endpoint")
  assert.equal(database.checkRuns[0].status, "healthy")
  assert.deepEqual(database.checkRuns[0].resultJson, {})
})
