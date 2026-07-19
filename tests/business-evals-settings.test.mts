import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isBusinessEvalsUiEnabled,
  isBusinessEvalsWorkspaceEnabled,
} from "../src/lib/features/business-evals.ts"

const workspaceSettings = readFileSync("src/lib/api/workspace-settings.server.ts", "utf8")
const workspaceRoute = readFileSync("src/app/api/settings/workspace/route.ts", "utf8")
const teamRoute = readFileSync("src/app/api/settings/team/route.ts", "utf8")
const memberRoute = readFileSync("src/app/api/settings/team/[userId]/route.ts", "utf8")
const billingRoute = readFileSync("src/app/api/settings/billing/route.ts", "utf8")
const accessRoute = readFileSync("src/app/api/business-evals/access/route.ts", "utf8")
const authBoundary = readFileSync("src/lib/api/business-evals-auth.server.ts", "utf8")
const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const envExample = readFileSync("ENV_EXAMPLE.md", "utf8")

test("business-evals cohort gate is global-or-allowlisted and defaults closed", () => {
  const workspaceId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  assert.equal(isBusinessEvalsUiEnabled({}), false)
  assert.equal(isBusinessEvalsWorkspaceEnabled(workspaceId, {}), false)
  assert.equal(isBusinessEvalsWorkspaceEnabled(workspaceId, {
    BUSINESS_EVALS_WORKSPACE_ALLOWLIST: ` other, ${workspaceId.toUpperCase()} `,
  }), true)
  assert.equal(isBusinessEvalsWorkspaceEnabled("not-selected", {
    BUSINESS_EVALS_WORKSPACE_ALLOWLIST: workspaceId,
  }), false)
  assert.equal(isBusinessEvalsWorkspaceEnabled("any-workspace", {
    NEXT_PUBLIC_BUSINESS_EVALS_UI: "enabled",
  }), true)
})

test("typed business-evals APIs enforce the server-side workspace feature gate", () => {
  assert.match(authBoundary, /options\.featureGate !== false/)
  assert.match(authBoundary, /isBusinessEvalsWorkspaceEnabled\(membership\.agency_id\)/)
  assert.match(authBoundary, /BUSINESS_EVALS_NOT_ENABLED/)
  assert.match(authBoundary, /WORKSPACE_REQUIRED/)
  assert.match(accessRoute, /requireBusinessEvalsAuth\(request, \{ featureGate: false, allowImplicitWorkspace: true \}\)/)
  assert.match(accessRoute, /"Cache-Control": "private, no-store"/)
  assert.match(envExample, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST=/)
})

test("workspace, team, and billing settings are backed by authenticated APIs", () => {
  assert.match(workspaceRoute, /export async function GET/)
  assert.match(workspaceRoute, /export async function PATCH/)
  assert.match(workspaceRoute, /roles: \["owner", "admin"\]/)
  assert.match(workspaceRoute, /expectedUpdatedAt: z\.string\(\)\.datetime\(\)/)
  assert.match(teamRoute, /export async function GET/)
  assert.match(teamRoute, /export async function POST/)
  assert.match(teamRoute, /roles: \["owner", "admin"\]/)
  assert.match(teamRoute, /actorRole: auth\.workspace\.role/)
  assert.match(memberRoute, /roles: \["owner"\]/)
  assert.match(memberRoute, /export async function PATCH/)
  assert.match(memberRoute, /export async function DELETE/)
  assert.match(billingRoute, /getWorkspaceBillingSettings/)
})

test("team invitations use the auth provider and an atomic seat-aware membership RPC", () => {
  assert.match(workspaceSettings, /\/auth\/v1\/invite\?redirect_to=/)
  assert.match(workspaceSettings, /actorRole !== "owner" && input\.role === "admin"/)
  assert.match(workspaceSettings, /rpc\/add_business_eval_workspace_member/)
  assert.match(workspaceSettings, /deleteSupabaseAuthUser\(invitedUserId\)/)
  assert.match(migration, /create or replace function public\.add_business_eval_workspace_member/)
  assert.match(migration, /from public\.agencies where id = p_agency_id for update/)
  assert.match(migration, /if p_role = 'admin' and actor_role <> 'owner'/)
  assert.match(migration, /if p_seat_limit is not null and occupied >= p_seat_limit/)
  assert.match(migration, /WORKSPACE_OWNER_ROLE_IMMUTABLE/)
  assert.match(migration, /WORKSPACE_OWNER_CANNOT_BE_REMOVED/)
  assert.match(migration, /revoke insert, update, delete on public\.memberships from authenticated/)
  assert.match(migration, /grant execute on function public\.add_business_eval_workspace_member[\s\S]+to service_role/)
})
