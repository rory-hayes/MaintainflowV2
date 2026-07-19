import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { runEndpointTest } from "../src/lib/core/check-runner.ts"
import {
  assertSafeSavedAssertions,
  assertSafeSavedCheckConfig,
  savedMonitorPolicyViolation,
  type SavedMonitorInput,
} from "../src/lib/core/saved-monitor-policy.ts"

const contractMigration = readFileSync(
  "supabase/maintainflow_public_monitor_contract_migration.sql",
  "utf8",
)
const freshSchema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const assuranceIntegrityMigration = readFileSync(
  "supabase/maintainflow_assurance_integrity_migration.sql",
  "utf8",
)
const migrationRunner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")

const safeMonitor = {
  endpointUrl: "https://status.example.com/health",
  method: "GET" as const,
  headers: {},
  requestBody: "",
}

test("saved monitor policy accepts only credential-free public HTTPS GET endpoints", () => {
  assert.equal(savedMonitorPolicyViolation(safeMonitor), null)

  const rejected: Array<Partial<SavedMonitorInput>> = [
    { endpointUrl: "http://status.example.com/health" },
    { endpointUrl: "https://user:" + "password@status.example.com/health" },
    { endpointUrl: "https://status.example.com/health?token=secret" },
    { endpointUrl: "https://status.example.com/health#secret" },
    { endpointUrl: "https://demo.maintainflow.test/healthy" },
    { endpointUrl: "https://localhost/health" },
    { endpointUrl: "https://service.internal/health" },
    { endpointUrl: "https://127.0.0.1/health" },
    { endpointUrl: "https://10.0.0.1/health" },
    { endpointUrl: "https://[::1]/health" },
    { method: "POST" },
    { requestBody: "{\"token\":\"secret\"}" },
    { headers: { Authorization: "Bearer secret" } },
    { headers: { Accept: "Bearer secret" } },
  ]

  for (const override of rejected) {
    assert.ok(savedMonitorPolicyViolation({ ...safeMonitor, ...override }))
  }
})

test("saved checks permit only threshold config and structural assertions", () => {
  assert.deepEqual(assertSafeSavedCheckConfig({
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
  }), {
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
  })
  assert.throws(() => assertSafeSavedCheckConfig({ url: "https://secret.example/?token=value" }), /override/)
  assert.throws(() => assertSafeSavedCheckConfig({ body: "password=secret" }), /override/)

  assert.equal(assertSafeSavedAssertions([
    { id: "response-exists", type: "response_exists", enabled: true },
    { id: "json-ok", type: "json_field_exists", path: "data.ok", enabled: true },
  ]).length, 2)
  assert.throws(() => assertSafeSavedAssertions([
    { id: "equals", type: "json_field_equals", path: "token", expected: "secret", enabled: true },
  ]), /only support/)
  assert.throws(() => assertSafeSavedAssertions([
    { id: "text", type: "text_contains", expected: "customer@example.com", enabled: true },
  ]), /only support/)
  assert.throws(() => assertSafeSavedAssertions([
    { id: "path", type: "json_field_exists", path: "data['secret']", enabled: true },
  ]), /dot-separated/)
})

test("synthetic demo execution fails closed when the runtime boundary disables it", async () => {
  let fetched = false
  const result = await runEndpointTest({
    url: "https://demo.maintainflow.test/healthy",
    method: "GET",
    headers: {},
    body: "",
    expectedStatus: 200,
    timeoutSeconds: 5,
    maxLatencyMs: 5_000,
    assertions: [{ id: "response-exists", type: "response_exists", enabled: true }],
  }, {
    allowSyntheticDemo: false,
    fetchImpl: async () => {
      fetched = true
      return new Response("ok")
    },
  })

  assert.equal(fetched, false)
  assert.equal(result.status, "skipped")
  assert.match(result.errorMessage, /disabled in production/)
})

test("contract and fresh schema enforce and scrub the saved monitor boundary", () => {
  for (const source of [contractMigration, freshSchema]) {
    assert.match(source, /saved_monitor_endpoint_is_safe/)
    assert.ok(source.includes("endpoint_url !~* '^https://[0-9.]+"))
    assert.ok(source.includes("localhost|local|internal|home\\.arpa"))
    assert.match(source, /saved_monitor_headers_are_safe/)
    assert.match(source, /saved_monitor_check_config_is_safe/)
    assert.match(source, /saved_monitor_assertions_are_safe/)
    assert.match(source, /workflows_saved_endpoint_safe/)
    assert.match(source, /workflows_saved_execution_safe/)
    assert.match(source, /checks_saved_config_safe/)
    assert.match(source, /checks_saved_assertions_safe/)
    assert.match(source, /checks_enforce_active_saved_endpoint/)
    assert.match(source, /checks_mark_assurance_reports_stale/)
    assert.match(source, /workflows_prevent_active_endpoint_removal/)
  }

  const checkStalenessTriggerIndex = contractMigration.indexOf(
    "create trigger checks_mark_assurance_reports_stale",
  )
  const disableIndex = contractMigration.indexOf("update public.checks check_state")
  const scrubWorkflowIndex = contractMigration.indexOf("update public.workflows workflow_state")
  assert.ok(checkStalenessTriggerIndex >= 0 && checkStalenessTriggerIndex < disableIndex)
  assert.ok(disableIndex >= 0 && disableIndex < scrubWorkflowIndex)
  assert.match(contractMigration, /endpoint_url = ''[\s\S]+encrypted_auth_config = '\{\}'::jsonb[\s\S]+request_body = ''/)
  assert.match(contractMigration, /assertions_json = '\[\]'::jsonb/)
  assert.doesNotMatch(contractMigration, /delete\s+from|truncate\s+table/i)

  assert.match(migrationRunner, /maintainflow_public_monitor_contract_migration\.sql/)
  assert.match(migrationRunner, /public_monitor_constraints_ready/)
  assert.match(migrationRunner, /public_monitor_triggers_ready/)
  assert.match(migrationRunner, /public_monitor_rows_safe/)
  assert.match(migrationRunner, /publicMonitorImpactBeforeContract/)
})

test("workflow definition changes and check definition changes stale prepared report PDFs", () => {
  for (const source of [freshSchema, assuranceIntegrityMigration]) {
    assert.match(source, /workflows_mark_assurance_reports_stale/)
    assert.match(source, /update of[\s\S]+encrypted_auth_config[\s\S]+request_body[\s\S]+expected_status[\s\S]+timeout_seconds[\s\S]+max_latency_ms[\s\S]+frequency_minutes[\s\S]+store_raw_response/)
    assert.match(source, /pdf_snapshot_version = null/)
  }

  assert.match(freshSchema, /create trigger checks_mark_assurance_reports_stale[\s\S]+update of[\s\S]+config_json[\s\S]+assertions_json/)
  assert.match(contractMigration, /create trigger checks_mark_assurance_reports_stale[\s\S]+update of[\s\S]+config_json[\s\S]+assertions_json/)
})
