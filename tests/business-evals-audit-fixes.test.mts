import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const adapters = readFileSync("src/components/evals/api-adapters.ts", "utf8")
const evalRuns = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
const evalRunRoute = readFileSync("src/app/api/eval-runs/route.ts", "utf8")
const scheduler = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
const projects = readFileSync("src/lib/api/projects.server.ts", "utf8")
const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
const routeQueries = readFileSync("src/components/evals/use-route-scoped-evals.ts", "utf8")
const projectPages = readFileSync("src/components/evals/pages/projects-pages.tsx", "utf8")
const journeyPages = readFileSync("src/components/evals/pages/journeys-pages.tsx", "utf8")
const onboarding = readFileSync("src/components/evals/pages/onboarding-page.tsx", "utf8")
const reportStorage = readFileSync("src/lib/reports/business-evals-report-pdf-storage.server.ts", "utf8")
const prepareReport = readFileSync("src/app/api/reports/[id]/prepare/route.ts", "utf8")
const downloadReport = readFileSync("src/app/api/reports/[id]/download/route.ts", "utf8")
const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const migrationRunner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")

test("manual and scheduled retries resolve an exact existing request before safety buckets", () => {
  assert.match(adapters, /pendingIdempotencyKey\(retryScope\)/)
  assert.match(adapters, /window\.sessionStorage\.setItem\(storageKey, created\)/)
  assert.match(adapters, /clearPendingIdempotencyKey\(retryScope, idempotencyKey\)/)

  const enqueue = evalRuns.match(/export async function enqueueEvalRunRecord[\s\S]*?\n}\n\nexport async function findExistingEvalRunReplay/)?.[0] ?? ""
  assert.ok(enqueue.indexOf("findExistingEvalRunReplay") < enqueue.indexOf("isBusinessEvalsRunnerEnabled"))
  assert.doesNotMatch(enqueue, /enforceBusinessEvalRateLimits/)

  const scheduledEnqueue = scheduler.match(/async function enqueueAndDispatchSchedule[\s\S]*?\n}\n\nfunction safeError/)?.[0] ?? ""
  assert.ok(scheduledEnqueue.indexOf("findExistingEvalRunReplay") < scheduledEnqueue.indexOf("getBusinessEvalsEntitlement"))
  assert.doesNotMatch(scheduledEnqueue, /enforceBusinessEvalRateLimits/)

  const replayRpc = migration.match(/create or replace function public\.get_business_eval_run_replay\([\s\S]*?\n\$\$;/)?.[0] ?? ""
  for (const requestField of [
    "workflow_id", "journey_version_id", "schedule_id", "trigger_source",
    "scheduled_for", "requested_by_user_id", "verification_issue_id",
  ]) assert.match(replayRpc, new RegExp(`existing_run\\.${requestField}`))
  assert.match(replayRpc, /Idempotency key was reused with a different eval-run request/)

  const enqueueRpc = migration.match(/create or replace function public\.enqueue_business_eval_run\([\s\S]*?\n\$\$;/)?.[0] ?? ""
  assert.ok(enqueueRpc.indexOf("select * into existing_run") < enqueueRpc.indexOf("consume_business_eval_rate_limit"))
  assert.equal((enqueueRpc.match(/consume_business_eval_rate_limit\(/g) ?? []).length, 4)
  assert.match(enqueueRpc, /business-evals:destination_domain:/)
  assert.doesNotMatch(evalRunRoute, /isBusinessEvalsRunnerEnabled/)
  assert.match(evalRunRoute, /Dispatch owns the final kill-switch recheck/)
})

test("project and journey summaries are bounded service-only windowed RPCs", () => {
  for (const rpc of ["get_business_eval_project_summaries", "get_business_eval_journey_summaries"]) {
    const body = migration.match(new RegExp(`create or replace function public\\.${rpc}\\([\\s\\S]*?\\n\\$\\$;`))?.[0] ?? ""
    assert.match(body, /row_number\(\) over/)
    assert.match(body, /partition by/)
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}`))
    assert.match(migrationRunner, new RegExp(`to_regprocedure\\('public\\.${rpc}`))
  }
  assert.match(migration, /eval_runs_project_created_idx/)
  assert.match(migration, /reports_project_created_idx/)

  const projectHydration = projects.match(/async function hydrateProjectSummaries[\s\S]*?\n}\n\nfunction timestampValue/)?.[0] ?? ""
  assert.match(projectHydration, /rpc\/get_business_eval_project_summaries/)
  assert.doesNotMatch(projectHydration, /eval_runs\?|reports\?|issues\?|workflows\?/)

  const journeyList = journeys.match(/export async function listJourneys[\s\S]*?\n}\n\nexport async function getJourney/)?.[0] ?? ""
  assert.match(journeyList, /rpc\/get_business_eval_journey_summaries/)
  assert.doesNotMatch(journeyList, /eval_runs\?|journey_schedules\?|checks\?/)
})

test("project paging, server journey filters, workspace-bound reports and Free copy remain truthful", () => {
  const projectDetail = projectPages.match(/export function ProjectDetailPage[\s\S]*?\n}\n\nfunction ProjectEditor/)?.[0] ?? ""
  assert.match(projectDetail, /pagination/)
  assert.match(projectDetail, /CollectionLoadMore state=\{pagination\.journeys\}/)

  assert.match(routeQueries, /searchParams\.get\("search"\)/)
  assert.match(routeQueries, /searchParams\.get\("status"\)/)
  assert.match(routeQueries, /for \(const \[name, value\] of new URLSearchParams\(filter\)\)/)
  assert.match(journeyPages, /router\.replace\(destination, \{ scroll: false \}\)/)
  assert.match(journeys, /status === "passed"\) return "eq\.healthy"/)
  assert.match(journeys, /status === "attention"\) return "in\.\(degraded,failed\)"/)

  assert.match(reportStorage, /Report not found in the selected workspace/)
  assert.match(prepareReport, /isBusinessEvalReport\(auth\.workspace\.id, id\)/)
  assert.match(downloadReport, /isBusinessEvalReport\(auth\.workspace\.id, id\)/)
  assert.match(onboarding, /Free includes one browser-only Lead form journey/)
  assert.doesNotMatch(onboarding, /Team trial unlocks browser journeys/)
})
