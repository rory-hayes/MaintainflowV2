import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { renderBusinessEvalReportPdf } from "../src/lib/reports/business-evals-report-pdf.server.ts"
import { createSyntheticRunValues } from "../src/lib/runner/synthetic-values.ts"
import { submittedMarkerForRun } from "../src/lib/email/eval-inbound.ts"

test("browser-only synthetic identities do not require inbound-email secrets", () => {
  const runId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
  const marker = submittedMarkerForRun(runId)
  const values = createSyntheticRunValues({
    runId,
    syntheticMarker: marker,
    inboundDomain: "example.invalid",
  })
  assert.match(values.email, /^run-[a-f0-9]{24}@example\.invalid$/)
  assert.match(values.message, /synthetic business-eval submission/i)
  assert.equal(values.marker, marker)
  assert.match(values.marker, /^MF-EVAL-[A-F0-9]{20}$/)
  assert.match(values.first_name, /019F7576DB/)
  assert.match(values.last_name, /019F7576DB/)
})

test("business-eval report rendering creates a real private PDF artifact", async () => {
  const buffer = await renderBusinessEvalReportPdf({
    brandName: "Maintain Flow",
    projectName: "Beacon CRM",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-18",
    generatedAt: "2026-07-18T12:00:00.000Z",
    snapshotVersion: 1,
    evidenceFingerprint: "a".repeat(64),
    metrics: { journeysCovered: 2, evalRuns: 12, passedRuns: 11, passRate: 91.67, incidents: 1, recoveries: 1 },
    journeys: [{ name: "Trial signup", template: "trial_signup", runCount: 12, latestVerdict: "passed" }],
    runs: [{ verdict: "passed", summary: "Every deterministic stage passed.", businessImpact: "", cleanupStatus: "passed", completedAt: "2026-07-18T11:00:00.000Z" }],
    incidents: [{ title: "Verification delay", severity: "high", status: "resolved", reportSafeSummary: "A passing verification rerun proved recovery." }],
  })
  assert.equal(buffer.subarray(0, 4).toString("utf8"), "%PDF")
  assert.ok(buffer.byteLength > 5_000)
})

test("scheduler, dispatch recovery, evidence retention and eval PDF routes fail closed", () => {
  const scheduler = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
  const dispatch = readFileSync("src/lib/workflows/dispatch-eval-run.server.ts", "utf8")
  const retention = readFileSync("src/lib/workflows/evidence-retention.server.ts", "utf8")
  const preparePdf = readFileSync("src/lib/reports/business-evals-report-pdf-storage.server.ts", "utf8")

  assert.match(scheduler, /BUSINESS_EVALS_SCHEDULER_KILL_SWITCH/)
  assert.match(scheduler, /schedule:\$\{schedule\.schedule_id\}:\$\{schedule\.scheduled_for\}/)
  assert.match(scheduler, /p_monthly_limit: entitlement\.runLimit/)
  assert.match(dispatch, /claim_eval_run_for_dispatch/)
  assert.match(dispatch, /claim_eval_runs_for_dispatch/)
  assert.match(dispatch, /release_eval_run_dispatch_lease/)
  assert.match(retention, /storage\/v1\/object\/\$\{EVAL_EVIDENCE_BUCKET\}/)
  assert.match(retention, /method: "DELETE"/)
  assert.match(preparePdf, /PDF_REPORTING_REQUIRED/)
  assert.match(preparePdf, /eval_evidence_fingerprint/)
  assert.doesNotMatch(preparePdf, /traceUrl|rawEmail|credentials/)
})

test("the browser guard checks every HTTP request for public-network safety", () => {
  const guard = readFileSync("src/lib/runner/browser-safety.server.ts", "utf8")
  assert.match(guard, /resolvePublicBrowserTarget\(request\.url\(\)\)/)
  assert.match(guard, /DNS_REBINDING_BLOCKED/)
  assert.match(guard, /requiresDestinationAuthorization/)
  assert.match(guard, /pinnedEndpointFetch\(url, validatedAddresses/)
  assert.match(guard, /networkMode === "external_proxy"/)
  assert.match(guard, /await route\.continue\(\)/)
  assert.match(guard, /Network\.setBypassServiceWorker/)
  assert.match(guard, /context\.routeWebSocket/)
  assert.match(guard, /context\.route\("\*\*\/\*"/)
  assert.match(guard, /MAX_BROWSER_RESPONSE_BYTES/)
  assert.match(guard, /firstResolution\.set[\s\S]{0,500}networkMode === "external_proxy"/)
  const provider = readFileSync("src/lib/runner/browserbase-provider.server.ts", "utf8")
  assert.match(provider, /ignoreCertificateErrors: false/)
})

test("report-safe screenshots mask fields and rendered synthetic identities", () => {
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(engine, /page\.locator\("input, textarea, select, option, \[contenteditable\]/)
  assert.match(engine, /Object\.values\(syntheticValues\)/)
  assert.match(engine, /page\.getByText\(value, \{ exact: false \}\)/)
  assert.match(engine, /style: REPORT_SAFE_SCREENSHOT_STYLE/)
  assert.match(engine, /redacted: true/)
})

test("the restricted runner stops when a payment or checkout surface appears", () => {
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(engine, /pageContainsExcludedPaymentSurface/)
  assert.match(engine, /PAYMENT_FLOW_EXCLUDED/)
  assert.match(engine, /input\[autocomplete\^='cc-'\]/)
  assert.match(engine, /checkout\.stripe\.com/)
})

test("customer-visible browser phases are attempted at most once", () => {
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  assert.match(workflow, /FatalError/)
  assert.match(workflow, /rpc\/begin_eval_run_side_effect_phase/)
  assert.match(workflow, /rpc\/complete_eval_run_side_effect_phase/)
  assert.match(workflow, /action\.type === "click"/)
  assert.match(workflow, /action\.type === "open_email_link"/)
  assert.match(workflow, /postEmailStages, session, workerId, true/)
  assert.match(workflow, /action\.type === "cleanup" && action\.mode === "in_product"/)
  assert.match(workflow, /The phase was not retried and the run is inconclusive/)
})

test("business-eval safety limits are shared across serverless workers", () => {
  const limiter = readFileSync("src/lib/api/business-evals-rate-limit.server.ts", "utf8")
  assert.match(limiter, /rpc\/consume_business_eval_rate_limit/)
  assert.match(limiter, /destination_domain/)
  assert.match(limiter, /createHash\("sha256"\)/)
  assert.doesNotMatch(limiter, /createFixedWindowRateLimiter|new Map/)
})

test("business-eval capacity uses the canonical fail-closed billing entitlement", () => {
  const service = readFileSync("src/lib/api/business-evals-entitlements.server.ts", "utf8")
  assert.match(service, /resolveBillingEntitlement\(billingInput, nowMs\)/)
  assert.match(service, /getEffectiveBillingPlan\(billingInput, nowMs\)/)
  assert.match(service, /stripe_customer_id,stripe_subscription_id,stripe_subscription_status/)
  assert.match(service, /entitlement\.state === "workspace_trial"/)
  assert.match(service, /entitlement\.grantsPaidAccess[\s\S]+override !== null/)
  assert.doesNotMatch(service, /const paidActive =/)
})

test("project and journey creation enforce plan limits inside locked database transactions", () => {
  const projects = readFileSync("src/lib/api/projects.server.ts", "utf8")
  const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  assert.match(projects, /rpc\/create_business_eval_project/)
  assert.match(projects, /rpc\/restore_business_eval_project/)
  assert.match(projects, /p_project_limit: entitlement\.projectLimit/)
  assert.match(projects, /p_journey_limit: entitlement\.journeyLimit/)
  assert.doesNotMatch(projects, /active\.length >= entitlement\.projectLimit/)
  assert.match(journeys, /rpc\/create_business_eval_journey/)
  assert.match(journeys, /p_journey_limit: entitlement\.journeyLimit/)
  assert.match(journeys, /DRAFT_REVISION_INVALID/)
  assert.match(journeys, /draft_definition_json: \{ \.\.\.input, draftRevision: input\.draftRevision \+ 1 \}/)
  assert.doesNotMatch(journeys, /active\.length >= entitlement\.journeyLimit/)
  assert.match(journeys, /clients!inner\(archived_at\)/)
  const capacity = readFileSync("src/lib/api/business-evals-entitlements.server.ts", "utf8")
  const runs = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
  const scheduler = readFileSync("src/lib/workflows/scheduled-evals.server.ts", "utf8")
  assert.match(capacity, /ACTIVE_PROJECT_LIMIT_EXCEEDED/)
  assert.match(capacity, /ACTIVE_JOURNEY_LIMIT_EXCEEDED/)
  assert.match(runs, /assertBusinessEvalsResourceCapacity/)
  assert.match(scheduler, /entitlement_blocked/)
})

test("public report access consumes only a current hashed share link", () => {
  const sharing = readFileSync("src/lib/api/report-sharing.server.ts", "utf8")
  assert.match(sharing, /hashReportShareToken/)
  assert.match(sharing, /if \(!isReportShareToken\(token\)\)[\s\S]*?SHARE_LINK_NOT_FOUND/)
  assert.match(sharing, /resolution=ignore-duplicates,return=representation/)
  assert.doesNotMatch(sharing, /resolution=merge-duplicates/)
  assert.match(sharing, /SHARE_LINK_REVOKED/)
  assert.match(sharing, /rpc\/consume_report_share_link/)
  assert.match(sharing, /snapshot_version: `eq\.\$\{Number\(link\.snapshot_version\)\}`/)
  assert.match(sharing, /evidence_fingerprint: `eq\.\$\{String\(link\.evidence_fingerprint\)\}`/)
  assert.match(sharing, /entitlement\.features\.whiteLabel/)
  assert.match(sharing, /brandName/)
  assert.match(sharing, /reportSafeScreenshotIds/)
  assert.match(sharing, /artifact_kind: "eq\.screenshot"/)
  assert.match(sharing, /redacted: "eq\.true"/)
})

test("legacy endpoint journeys cannot enter the browser eval runner", () => {
  const evalRuns = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
  assert.match(evalRuns, /LEGACY_ENDPOINT_RUNNER_REQUIRED/)
  assert.match(evalRuns, /deterministic endpoint monitor/)
})

test("journey evidence cannot be reparented or retemplated by a draft update", () => {
  const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  assert.match(journeys, /JOURNEY_PROJECT_IMMUTABLE/)
  assert.match(journeys, /JOURNEY_TEMPLATE_IMMUTABLE/)
})

test("an idempotent manual retry recovers an undispatched eval run", () => {
  const route = readFileSync("src/app/api/eval-runs/route.ts", "utf8")
  assert.match(route, /getEvalRunDispatchState/)
  assert.match(route, /!dispatchState\.orchestrationRunId/)
  assert.match(route, /dispatchState\.dispatchState !== "dispatching"/)
})

test("incident fingerprints survive immutable journey republishing", () => {
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")
  assert.match(workflow, /context\.journeyId/)
  assert.match(workflow, /firstProblemStage\?\.key/)
  assert.doesNotMatch(workflow, /context\.journeyVersionId}:\$\{firstProblem\.stageId/)
})

test("project owner attestations are appended through the immutable authorization RPC", () => {
  const projects = readFileSync("src/lib/api/projects.server.ts", "utf8")
  const route = readFileSync("src/app/api/projects/[id]/authorization/route.ts", "utf8")
  assert.match(projects, /rpc\/record_project_authorization/)
  assert.match(projects, /rpc\/revoke_project_authorizations_and_pause/)
  assert.doesNotMatch(projects, /project_authorizations\?on_conflict/)
  assert.match(route, /roles: \["owner"\]/)
  assert.doesNotMatch(route, /roles: \["owner", "admin"\]/)
})
