import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  legacyClientRowSchema,
  legacyCoreSyncRequestSchema,
  legacyWorkflowRowSchema,
} from "../src/lib/legacy/core-sync-contract.ts"

const workspaceId = "10000000-0000-4000-8000-000000000001"
const userId = "10000000-0000-4000-8000-000000000002"
const clientId = "10000000-0000-4000-8000-000000000003"
const workflowId = "10000000-0000-4000-8000-000000000004"
const now = "2026-07-19T10:00:00.000Z"

const clientRow = {
  id: clientId,
  agency_id: workspaceId,
  name: "Acme",
  slug: "acme",
  website: "https://acme.example",
  owner_user_id: userId,
  report_recipient_email: "ops@acme.example",
  report_cadence: "monthly" as const,
  notes: "",
  archived_at: null,
  created_at: now,
  updated_at: now,
}

const workflowRow = {
  id: workflowId,
  agency_id: workspaceId,
  client_id: clientId,
  name: "Health endpoint",
  type: "http_endpoint" as const,
  environment: "production" as const,
  endpoint_url: "https://status.acme.example/health",
  method: "GET" as const,
  auth_type: "none" as const,
  encrypted_auth_config: { headers: [] },
  request_body: "" as const,
  expected_status: 200,
  timeout_seconds: 10,
  max_latency_ms: 5_000,
  frequency_minutes: 60,
  retries: 2,
  report_included: true,
  store_raw_response: false as const,
  status: "healthy" as const,
  health_score: 100,
  last_check_run_at: now,
  archived_at: null,
  created_at: now,
  updated_at: now,
}

test("legacy synchronization accepts only the bounded rollback-safe client and endpoint contracts", () => {
  assert.equal(legacyClientRowSchema.safeParse(clientRow).success, true)
  assert.equal(legacyWorkflowRowSchema.safeParse(workflowRow).success, true)
  assert.equal(legacyWorkflowRowSchema.safeParse({ ...workflowRow, method: "POST" }).success, false)
  assert.equal(legacyWorkflowRowSchema.safeParse({
    ...workflowRow,
    encrypted_auth_config: { headers: [{ key: "Authorization", value: "secret" }] },
  }).success, false)
  assert.equal(legacyWorkflowRowSchema.safeParse({ ...workflowRow, arbitrary_script: "alert(1)" }).success, false)

  assert.equal(legacyCoreSyncRequestSchema.safeParse({
    table: "clients",
    creates: [clientRow],
    updates: [],
  }).success, true)
  assert.equal(legacyCoreSyncRequestSchema.safeParse({
    table: "clients",
    creates: [clientRow],
    updates: [{ expectedUpdatedAt: now, row: clientRow }],
  }).success, false)
})

test("rollback browser sync delegates client and workflow writes to the authenticated server route", () => {
  const browserSync = readFileSync("src/lib/supabase/core-sync.ts", "utf8")
  const route = readFileSync("src/app/api/legacy-core-sync/route.ts", "utf8")

  assert.doesNotMatch(browserSync, /syncMutableRows\("(?:clients|workflows)"/)
  assert.match(browserSync, /syncLegacyCoreRows\("clients"/)
  assert.match(browserSync, /syncLegacyCoreRows\("workflows"/)
  assert.match(browserSync, /fetch\("\/api\/legacy-core-sync"/)
  assert.match(browserSync, /X-MaintainFlow-Workspace-Id/)
  assert.match(browserSync, /Authorization: `Bearer \$\{accessToken\}`/)

  assert.match(route, /requireBusinessEvalsAuth\(request/)
  assert.match(route, /featureGate: false/)
  assert.match(route, /roles: \["owner", "admin", "member"\]/)
  assert.match(route, /parseRequestJson\(request, legacyCoreSyncRequestSchema\)/)
  assert.match(route, /agencyId: auth\.workspace\.id/)
  assert.match(route, /userId: auth\.user\.id/)
})

test("server-authorized writes preserve tenancy, CAS, legacy endpoint policy and collision safety", () => {
  const server = readFileSync("src/lib/legacy/core-sync.server.ts", "utf8")

  assert.match(server, /assertRequestTenancy\(input\.agencyId, input\.request\)/)
  assert.match(server, /row\.agency_id !== agencyId/)
  assert.match(server, /assertWorkspaceMember\(agencyId, ownerUserId\)/)
  assert.match(server, /assertProjectInWorkspace\(agencyId, row\.client_id/)
  assert.match(server, /assertSavedMonitorPolicy/)
  assert.match(server, /updated_at: `eq\.\$\{expectedUpdatedAt\}`/)
  assert.match(server, /journey_template: "eq\.legacy_endpoint"/)
  assert.match(server, /LEGACY_SYNC_ID_CONFLICT/)
  assert.match(server, /if \(!rowMatchesPatch\(existing, expectedCreate\)\)/)
  assert.match(server, /revoke_project_authorizations_and_pause/)
})

test("database grants keep browser DML revoked while service-only creation remains available", () => {
  for (const path of [
    "supabase/maintainflow_schema.sql",
    "supabase/maintainflow_business_evals_migration.sql",
  ]) {
    const sql = readFileSync(path, "utf8")
    assert.match(sql, /revoke insert, update, delete on public\.clients, public\.workflows from authenticated;/)
    assert.match(sql, /grant select on public\.clients, public\.workflows to authenticated;/)
    assert.match(sql, /create or replace function public\.create_legacy_endpoint_workflow/)
    assert.match(sql, /revoke all on function public\.create_legacy_endpoint_workflow\([\s\S]*?from public, anon, authenticated;/)
    assert.match(sql, /grant execute on function public\.create_legacy_endpoint_workflow\([\s\S]*?to service_role;/)
  }
})
