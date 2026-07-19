import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { projectResponseSchema } from "../src/lib/api/business-evals-response-schemas.ts"

const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const journeyServer = readFileSync("src/lib/api/journeys.server.ts", "utf8")
const archiveRoute = readFileSync("src/app/api/journeys/[id]/archive/route.ts", "utf8")
const journeyRoute = readFileSync("src/app/api/journeys/route.ts", "utf8")
const projectServer = readFileSync("src/lib/api/projects.server.ts", "utf8")
const authorizationRoute = readFileSync("src/app/api/projects/[id]/authorization/route.ts", "utf8")
const projectPages = readFileSync("src/components/evals/pages/projects-pages.tsx", "utf8")
const routeQueries = readFileSync("src/components/evals/use-route-scoped-evals.ts", "utf8")

test("journey archive and restore are durable tenant-scoped owner/admin transitions", () => {
  assert.match(migration, /create or replace function public\.set_business_eval_journey_archived/)
  assert.match(migration, /membership\.role in \('owner'::public\.agency_role, 'admin'::public\.agency_role\)/)
  assert.match(migration, /journey\.id = p_workflow_id and journey\.agency_id = p_agency_id/)
  assert.match(migration, /archived_at = changed_at/)
  assert.match(migration, /schedule[\s\S]+enabled = false[\s\S]+lease_expires_at = null/)
  assert.match(migration, /check_state[\s\S]+enabled = false[\s\S]+lease_expires_at = null/)
  assert.match(migration, /cancel_requested_at = coalesce\(run\.cancel_requested_at, changed_at\)/)
  assert.match(migration, /project\.archived_at is null/)
  assert.match(migration, /JOURNEY_LIMIT_REACHED/)
  assert.match(migration, /business_eval_journey_archived/)
  assert.match(migration, /business_eval_journey_restored/)
  assert.match(migration, /grant execute on function public\.set_business_eval_journey_archived\(uuid,uuid,uuid,boolean,integer\) to service_role/)
  assert.match(archiveRoute, /roles: \["owner", "admin"\]/)
  assert.match(archiveRoute, /export async function PUT/)
  assert.match(archiveRoute, /export async function DELETE/)
  assert.match(journeyServer, /rpc\/set_business_eval_journey_archived/)
  assert.match(journeyServer, /assertJourneyNotArchived/)
})

test("project detail includes archived journeys and exposes explicit restore controls", () => {
  assert.match(journeyRoute, /includeArchivedQuerySchema/)
  assert.match(routeQueries, /includeArchived: "true"/)
  assert.match(projectPages, /<JourneyArchiveControl journey=\{journey\}/)
  assert.match(projectPages, /The journey will return paused and unscheduled/)
  assert.match(projectPages, /method: restoring \? "DELETE" : "PUT"/)
})

test("projects expose real owner identity and latest immutable attestation", () => {
  assert.match(projectServer, /select: "id,name,email"/)
  assert.match(projectServer, /ownerName:/)
  assert.match(projectServer, /ownerEmail:/)
  assert.match(projectServer, /getLatestProjectAuthorization/)
  assert.match(projectServer, /order: "attested_at\.desc,created_at\.desc"/)
  assert.match(authorizationRoute, /export async function GET/)
  assert.match(authorizationRoute, /roles: \["owner"\]/)
  assert.doesNotMatch(authorizationRoute, /roles: \["owner", "admin"\]/)
  for (const label of ["Owner:", "Approved action domains", "Attestation version", "Authorized by", "Recorded", "Revocation"]) {
    assert.match(projectPages, new RegExp(label))
  }
})

test("project response validation retains owner and authorization evidence", () => {
  const result = projectResponseSchema.safeParse({
    id: "project-1",
    name: "Beacon CRM",
    website: "https://beacon.example.com",
    kind: "client_site",
    health: "healthy",
    activeJourneys: 1,
    legacyEndpointJourneys: 0,
    businessEvalJourneys: 1,
    openIncidents: 0,
    lastRunAt: null,
    ownerUserId: "user-1",
    ownerName: "Alex Morgan",
    ownerEmail: "alex@example.com",
    reportStatus: null,
    archivedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    authorization: {
      id: "authorization-1",
      domain: "beacon.example.com",
      approvedActionDomains: ["beacon.example.com", "verify.example.com"],
      attestationVersion: "2026-07-18",
      actor: { userId: "user-1", name: "Alex Morgan", email: "alex@example.com" },
      recordedAt: "2026-07-19T00:00:00.000Z",
      revokedAt: null,
      state: "current",
    },
  })
  assert.equal(result.success, true)
  assert.equal(projectResponseSchema.safeParse({
    ...(result.success ? result.data : {}),
    authorization: { ...(result.success ? result.data.authorization : {}), state: "unknown" },
  }).success, false)
})
