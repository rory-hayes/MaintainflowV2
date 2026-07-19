import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { preserveValidDatabaseTimestamp } from "../src/lib/core/database-timestamp.ts"
import { endpointInputFromSavedCheck } from "../src/lib/core/saved-check-config.ts"
import {
  createAgencyWorkspace,
  createClientRecord,
  createWorkflowReadyForFirstRun,
  emptyCoreDatabase,
} from "../src/lib/core/local-store.ts"

const user = {
  id: "user_boundary",
  name: "Boundary Tester",
  email: "boundary@maintainflow.test",
  company: "Boundary Ops",
  role: "Owner",
}

test("a production workflow is saved without browser-issued evidence before its server run", () => {
  let database = createAgencyWorkspace(emptyCoreDatabase(), user, {
    name: "Boundary Ops",
    slug: "boundary-ops",
  })
  const agency = database.agencies[0]
  database = createClientRecord(database, agency.id, user.id, { name: "Client One" })
  const client = database.clients[0]
  database = createWorkflowReadyForFirstRun(database, agency.id, user.id, {
    clientId: client.id,
    name: "Saved production endpoint",
    endpointUrl: "https://status.example.com/healthy",
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
  })

  assert.equal(database.checkRuns.length, 0)
  assert.equal(database.issues.length, 0)
  assert.equal(database.workflows[0].status, "pending")
  assert.equal(database.workflows[0].lastCheckRunAt, null)
  assert.equal(database.checks[0].enabled, true)
  assert.equal(database.checks[0].pendingSetup, false)
  assert.equal(database.checks[0].lastRunAt, null)
  assert.equal(
    new Date(database.checks[0].nextRunAt!).getTime() - new Date(database.checks[0].createdAt).getTime(),
    5 * 60_000
  )
})

test("database compare-and-swap timestamps preserve PostgreSQL microseconds exactly", () => {
  const postgresTimestamp = "2026-07-13T12:34:56.123456+00:00"

  assert.equal(preserveValidDatabaseTimestamp(postgresTimestamp), postgresTimestamp)
  assert.equal(preserveValidDatabaseTimestamp("not-a-timestamp"), null)
})

test("manual and scheduled evidence use canonical workflow transport and threshold-only check config", () => {
  const input = endpointInputFromSavedCheck({
    configJson: {
      url: "https://workflow.example/health",
      method: "GET",
      assertionCount: 1,
      expectedStatus: 202,
      timeoutSeconds: 7,
      maxLatencyMs: 2_500,
    },
    assertions: [{ id: "exists", type: "response_exists", enabled: true }],
    endpointUrl: "https://workflow.example/health",
    method: "GET",
    encryptedAuthConfig: { headers: [] },
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
  })

  assert.equal(input.url, "https://workflow.example/health")
  assert.equal(input.method, "GET")
  assert.equal(input.body, "")
  assert.equal(input.expectedStatus, 202)
  assert.deepEqual(input.headers, {})
  assert.deepEqual(input.assertions.map((assertion) => assertion.id), ["exists"])
})

test("legacy saved transport mismatches and request material fail closed", () => {
  const canonical = {
    assertions: [{ id: "exists", type: "response_exists", enabled: true }],
    endpointUrl: "https://workflow.example/health",
    method: "GET" as const,
    encryptedAuthConfig: { headers: [] },
    requestBody: "",
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
  }

  assert.throws(() => endpointInputFromSavedCheck({
    ...canonical,
    configJson: { url: "https://attacker.example/health" },
  }), /does not match/)
  assert.throws(() => endpointInputFromSavedCheck({
    ...canonical,
    configJson: { method: "POST" },
  }), /does not match/)
  assert.throws(() => endpointInputFromSavedCheck({
    ...canonical,
    configJson: { body: "credential=secret" },
  }), /request bodies/)
})

test("persisted evidence ignores browser-supplied endpoint results and reruns saved configuration", () => {
  const route = readFileSync("src/app/api/checks/test/route.ts", "utf8")
  const serverRunner = readFileSync("src/lib/supabase/persisted-check.server.ts", "utf8")
  const hook = readFileSync("src/hooks/use-core-loop.ts", "utf8")

  assert.match(route, /checkIdFromBody/)
  assert.match(route, /runAndPersistAuthorizedCheck\(auth\.token, persistedCheckId\)/)
  assert.match(serverRunner, /workflows\?\$\{query/)
  assert.match(serverRunner, /checks\?\$\{query/)
  assert.match(serverRunner, /endpointInputFromSavedCheck/)
  assert.match(serverRunner, /runEndpoint \?\? runEndpointTest/)
  assert.match(serverRunner, /rpc\/record_assurance_check_result/)
  assert.match(serverRunner, /p_expected_check_updated_at/)
  assert.match(serverRunner, /p_expected_workflow_updated_at/)
  assert.match(hook, /createWorkflowReadyForFirstRun/)
  assert.match(hook, /recordedResult = await runPersistedCheck\(createdCheck\.id\)/)
  assert.match(hook, /const stagedLocalDatabase = createWorkflowReadyForFirstRun/)
  assert.match(hook, /await runPersistedCheck\(check\.id\)/)
})
