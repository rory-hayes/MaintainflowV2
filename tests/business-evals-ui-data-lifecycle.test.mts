import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const adapters = readFileSync("src/components/evals/api-adapters.ts", "utf8")
const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8")
const evalsLayout = readFileSync("src/app/(evals)/layout.tsx", "utf8")
const conditionalRoute = readFileSync("src/components/evals/evals-conditional-route.tsx", "utf8")
const evalsRouteFallback = readFileSync("src/components/evals/evals-route-fallback.tsx", "utf8")
const routeQueries = readFileSync("src/components/evals/use-route-scoped-evals.ts", "utf8")
const boundary = readFileSync("src/components/evals/evals-route-boundary.tsx", "utf8")
const provider = readFileSync("src/components/evals/evals-provider.tsx", "utf8")
const runsPage = readFileSync("src/components/evals/pages/eval-runs-pages.tsx", "utf8")
const builder = readFileSync("src/components/evals/pages/journeys-pages.tsx", "utf8")
const journeyDetail = readFileSync("src/components/evals/pages/journey-detail-page.tsx", "utf8")
const shell = readFileSync("src/components/evals/evals-app-shell.tsx", "utf8")
const journeyRoute = readFileSync("src/app/api/journeys/route.ts", "utf8")
const incidentRoute = readFileSync("src/app/api/incidents/route.ts", "utf8")
const resumeRoute = readFileSync("src/app/api/journeys/[id]/resume/route.ts", "utf8")
const journeyServer = readFileSync("src/lib/api/journeys.server.ts", "utf8")
const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const previewE2e = readFileSync("tests/e2e/business-evals-preview.spec.ts", "utf8")

test("query-driven eval routes are enclosed by a server Suspense boundary", () => {
  assert.match(evalsLayout, /import \{ Suspense, type ReactNode \} from "react"/)
  assert.match(evalsLayout, /<Suspense fallback=\{<EvalsRouteFallback \/>\}>[\s\S]*?<EvalsRouteBoundary/)
  assert.match(conditionalRoute, /import \{ Suspense, type ReactNode \} from "react"/)
  assert.equal(conditionalRoute.match(/<Suspense fallback=\{<EvalsRouteFallback \/>\}>/g)?.length, 2)
  assert.match(evalsRouteFallback, /aria-busy="true"/)
  assert.match(ciWorkflow, /name: Build canary route tree[\s\S]*?NEXT_PUBLIC_BUSINESS_EVALS_UI: "false"/)
  assert.match(ciWorkflow, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST: "00000000-0000-4000-8000-000000000099"/)
})

test("authenticated eval UI uses route-scoped cursor pages instead of a five-collection workspace mirror", () => {
  assert.doesNotMatch(adapters, /limit=100|loadProductionEvalsData/)
  assert.match(routeQueries, /useInfiniteQuery/)
  assert.match(routeQueries, /getNextPageParam:\s*\(lastPage\) => lastPage\.meta\?\.nextCursor/)
  assert.match(routeQueries, /route\.journeyList \|\| Boolean\(route\.projectDetailId\)/)
  assert.match(routeQueries, /route\.runList \|\| Boolean\(route\.journeyDetailId\)/)
  assert.match(routeQueries, /route\.incidentList \|\| Boolean\(route\.projectDetailId\)/)
  assert.match(routeQueries, /route\.reportList \|\| Boolean\(route\.projectDetailId\)/)
  assert.match(provider, /pagination:\s*EvalsPaginationState/)
  assert.match(shell, /Load more projects/)
  assert.match(journeyRoute, /projectId: assertUuid\(projectId, "project ID"\)/)
  assert.match(incidentRoute, /projectId: assertUuid\(projectId, "project ID"\)/)
})

test("queued and running evals poll to a terminal record and can request cancellation", () => {
  assert.match(routeQueries, /\["queued", "claimed", "running", "waiting_for_email"\]/)
  assert.match(routeQueries, /pollActiveRun[\s\S]*?1_500/)
  assert.match(adapters, /method:\s*"DELETE"/)
  assert.match(runsPage, /Cancel run/)
  assert.match(runsPage, /Required cleanup will still be attempted/)
  assert.match(provider, /cancelRun:\s*\(id: string\)/)
})

test("the builder gates schedules on the completed supervised run truth", () => {
  assert.match(builder, /supervisedRunQuery = useQuery/)
  assert.match(builder, /supervisedRun\?\.status === "passed"/)
  assert.match(builder, /template !== "trial_signup" \|\| supervisedRun\.cleanupStatus === "passed"/)
  assert.match(builder, /disabled=\{saving \|\| !supervisedPassed\}/)
  assert.match(builder, /configureJourneySchedule\(createdId, true, 1_440\)/)
})

test("development preview keeps the complete builder journey interactive without production APIs", () => {
  assert.match(builder, /workspaceId\s*\?\s*\(await businessEvalsRequest\("\/api\/journey-scans"/)
  assert.match(builder, /:\s*previewJourneyScan\(startUrl, template\)/)
  assert.match(builder, /if \(workspaceId\) \{[\s\S]*?\/publish/)
  assert.match(builder, /preview-forwarding@inbound\.maintainflow\.test/)
  assert.match(builder, /projectId: workspaceId \? projectId : "00000000-0000-4000-8000-000000000001"/)
  assert.match(builder, /return workspaceId \? validated : \{ \.\.\.validated, projectId \}/)
  assert.match(provider, /providerMode !== "preview"/)
  assert.match(provider, /setPreviewJourneys/)
  assert.match(previewE2e, /Lead builder reaches a supervised pass and daily schedule/)
  assert.match(previewE2e, /expect\(browserErrors\)\.toEqual\(\[\]\)/)
})

test("owner and admin resume clears only the execution pause and cannot bypass safety proof", () => {
  assert.match(resumeRoute, /roles: \["owner", "admin"\]/)
  assert.match(journeyServer, /const protectedPauseReasons = new Set\(\[/)
  assert.match(journeyServer, /"cleanup_failed"/)
  assert.match(journeyServer, /"project_authorization_revoked"/)
  const resumeBody = journeyServer.match(/export async function resumeJourney[\s\S]*?\n}\n\nexport async function configureJourneySchedule/)?.[0] ?? ""
  assert.match(resumeBody, /paused_at: null, pause_reason: ""/)
  assert.doesNotMatch(resumeBody, /journey_schedules|enabled:\s*true/)
  assert.match(journeyServer, /rpc\/configure_journey_schedule/)
  assert.match(migration, /trigger_source = 'supervised'/)
})

test("eval runs stay subordinate to Journeys and preview mode covers every eval route only when enabled by development", () => {
  const primaryNav = shell.match(/const primaryNav = \[[\s\S]*?\] as const/)?.[0] ?? ""
  assert.doesNotMatch(primaryNav, /eval-runs|Eval runs/)
  assert.match(boundary, /if \(previewEnabled\) return <EvalsProvider mode="preview"/)
  assert.match(provider, /previewMode: providerMode === "preview"/)
  assert.match(shell, /const preview = previewMode/)
  const forwardingEffect = journeyDetail.match(/useEffect\(\(\) => \{[\s\S]*?forwarding-address[\s\S]*?\}, \[journeyId, workspaceId\]\)/)?.[0] ?? ""
  assert.match(forwardingEffect, /if \(!workspaceId\) return/)
  assert.match(builder, /if \(!workspaceId \|\| !existing\?\.id \|\| existingLeadProofMode/)
})
