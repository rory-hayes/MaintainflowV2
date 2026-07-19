import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  reportResponseSchema,
  sharedReportResponseSchema,
} from "../src/lib/api/business-evals-response-schemas.ts"
import { buildReportSafeContent } from "../src/lib/reports/report-safe-contract.ts"

const fingerprint = "a".repeat(64)
const snapshot = {
  schemaVersion: 1,
  generatedAt: "2026-07-19T10:00:00.000Z",
  summary: "The critical journeys remained measurable.",
  metrics: { journeysCovered: 1, evalRuns: 2, passedRuns: 1, passRate: 50, incidents: 2, recoveries: 1 },
  journeys: [{
    journeyId: "journey-1",
    name: "Trial signup",
    template: "trial_signup",
    runCount: 2,
    latestVerdict: "passed",
    latestCompletedAt: "2026-07-19T09:00:00.000Z",
    trace: "must-not-survive",
  }],
  runs: [{
    runId: "run-1",
    journeyId: "journey-1",
    journeyVersionId: "private-version-id",
    triggerSource: "scheduled",
    verdict: "passed",
    summary: "Every required stage passed.",
    businessImpact: "Trial activation remained available.",
    cleanupStatus: "passed",
    completedAt: "2026-07-19T09:00:00.000Z",
    durationMs: 1_200,
    rawEmail: "private@example.test",
    stages: [{
      position: 0,
      verdict: "passed",
      expected: "The workspace appears.",
      errorCode: null,
      durationMs: 400,
      networkSummary: { authorization: "secret" },
      artifacts: [{
        artifactId: "019f7576-dbaa-7a02-9787-d0f9a03b48e4",
        kind: "screenshot",
        mimeType: "image/png",
        storagePath: "private/workspace/path.png",
        signedUrl: "https://storage.example/private",
      }],
    }],
  }],
  incidents: [{
    incidentId: "incident-1",
    journeyId: "journey-1",
    sourceEvalRunId: "run-failed",
    verificationEvalRunId: "run-1",
    severity: "high",
    status: "resolved",
    title: "Verification email delay",
    reportSafeSummary: "A linked passing rerun proved recovery.",
    createdAt: "2026-07-18T09:00:00.000Z",
    resolvedAt: "2026-07-19T09:00:00.000Z",
    credentials: "must-not-survive",
  }, {
    incidentId: "incident-2",
    journeyId: "journey-1",
    sourceEvalRunId: "run-2",
    verificationEvalRunId: null,
    severity: "medium",
    status: "open",
    title: "New activation issue",
    reportSafeSummary: "The configured outcome was not reached.",
    createdAt: "2026-07-19T09:30:00.000Z",
    resolvedAt: null,
  }],
  futurePrivateField: { emailBody: "future private body", traceUrl: "secret" },
}

test("the report-safe projection preserves business proof through an explicit privacy allowlist", () => {
  const content = buildReportSafeContent({
    snapshot,
    source: "business_eval",
    snapshotVersion: 3,
    evidenceFingerprint: fingerprint,
  })

  assert.equal(content.coverage.journeys.length, 1)
  assert.equal(content.coverage.journeys[0]?.name, "Trial signup")
  assert.equal(content.evidenceSummaries.length, 1)
  assert.equal(content.evidenceSummaries[0]?.stages[0]?.artifacts[0]?.artifactId, "019f7576-dbaa-7a02-9787-d0f9a03b48e4")
  assert.equal(content.incidents.length, 2)
  assert.equal(content.recoveries.length, 1)
  assert.equal(content.recoveries[0]?.verificationEvalRunId, "run-1")
  assert.equal(content.metrics.recoveries, 1)
  assert.equal(content.provenance.evidenceFingerprint, fingerprint)

  const serialized = JSON.stringify(content)
  for (const secret of ["must-not-survive", "private@example.test", "private/workspace/path.png", "future private body", "private-version-id"]) {
    assert.equal(serialized.includes(secret), false)
  }
  for (const blockedKey of ["rawEmail", "networkSummary", "storagePath", "signedUrl", "credentials", "futurePrivateField", "triggerSource", "journeyVersionId"]) {
    assert.equal(serialized.includes(blockedKey), false)
  }
})

test("authenticated and public report response schemas strictly validate every nested proof section", () => {
  const content = buildReportSafeContent({
    snapshot,
    source: "business_eval",
    snapshotVersion: 3,
    evidenceFingerprint: fingerprint,
  })
  const authenticated = {
    id: "report-1",
    projectId: "project-1",
    projectName: "Beacon CRM",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-19",
    status: "ready",
    snapshotVersion: 3,
    source: "business_eval",
    evidenceModel: "Business eval",
    stageEvidenceAvailable: true,
    shareEligible: true,
    hasActiveShare: true,
    coverageDisclosure: "Business-eval journey evidence only.",
    ...content,
    evidenceFingerprint: fingerprint,
    staleAt: null,
    pdfReady: true,
    shares: [],
    projectArchivedAt: null,
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  }
  assert.equal(reportResponseSchema.safeParse(authenticated).success, true)
  assert.equal(reportResponseSchema.safeParse({
    ...authenticated,
    coverage: { ...authenticated.coverage, journeys: [{ ...authenticated.coverage.journeys[0], trace: "private" }] },
  }).success, false)

  const shared = {
    id: "report-1",
    projectName: "Beacon CRM",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-19",
    snapshotVersion: 3,
    expiresAt: "2026-07-26T10:00:00.000Z",
    brandName: "Maintain Flow",
    source: "business_eval",
    evidenceModel: "Business eval",
    stageEvidenceAvailable: true,
    coverageDisclosure: "Business-eval journey evidence only.",
    ...content,
    evidenceFingerprint: fingerprint,
  }
  assert.equal(sharedReportResponseSchema.safeParse(shared).success, true)
  assert.equal(sharedReportResponseSchema.safeParse({ ...shared, snapshot }).success, false)
  assert.equal(sharedReportResponseSchema.safeParse({ ...shared, rawEmail: "private" }).success, false)
})

test("report UI and share lifecycle keep rich proof, active status and public parsing truthful", () => {
  const reports = readFileSync("src/lib/api/reports.server.ts", "utf8")
  const sharing = readFileSync("src/lib/api/report-sharing.server.ts", "utf8")
  const adapter = readFileSync("src/components/evals/api-adapters.ts", "utf8")
  const ui = readFileSync("src/components/evals/pages/reports-pages.tsx", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")

  assert.match(reports, /buildReportSafeContent/)
  assert.doesNotMatch(reports, /snapshot\.recoveries \?\? \[\]/)
  assert.match(reports, /rpc\/get_business_eval_report_active_share_flags/)
  assert.match(adapter, /journeyCoverage: arrayOfRows\(coverage\.journeys\)/)
  assert.match(adapter, /verifiedRecoveries: arrayOfRows\(row\.recoveries\)/)
  assert.match(adapter, /evidenceSummaries: arrayOfRows\(row\.evidenceSummaries\)/)
  assert.match(adapter, /typeof row\.hasActiveShare === "boolean"/)

  for (const section of ["Journey coverage", "Report-safe eval evidence", "Incidents", "Verified recoveries", "Evidence provenance"]) {
    assert.match(ui, new RegExp(section))
  }
  assert.match(ui, /parseBusinessEvalsResponsePayload\(payload, sharedReportResponseSchema\)/)
  assert.doesNotMatch(ui, /report\.snapshot(?:\.|\[)/)
  assert.match(ui, /queryKey: \["business-evals", workspaceId\]/)
  assert.match(ui, /nativeButton=\{false\} render=\{<Link href=\{shareUrl\}/)

  assert.doesNotMatch(sharing, /redactSharedReportSnapshot/)
  assert.match(sharing, /buildReportSafeContent/)
  assert.match(sharing, /reportSafeScreenshotIds\(shared\.report\)/)
  assert.doesNotMatch(sharing, /reportSafeScreenshotIds\(shared\.snapshot\)/)
  assert.match(sharing, /return \{ agencyId: String\(link\.agency_id\), report: publicReport \}/)

  assert.match(migration, /get_business_eval_report_active_share_flags/)
  assert.match(migration, /cardinality\(p_report_ids\) between 1 and 100/)
  assert.match(migration, /link\.snapshot_version = requested\.snapshot_version/)
  assert.match(migration, /link\.evidence_fingerprint = requested\.evidence_fingerprint/)
  assert.match(migration, /link\.revoked_at is null[\s\S]+link\.expires_at > now\(\)/)
  assert.match(migration, /revoke all on function public\.get_business_eval_report_active_share_flags\(uuid,uuid\[\]\) from public, anon, authenticated/)
})
