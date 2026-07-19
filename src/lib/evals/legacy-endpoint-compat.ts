export type LegacyEndpointRunRow = Record<string, unknown>

export type LegacyEndpointEvidence = {
  checkId: string
  checkName: string
  evidenceOrigin: "legacy_browser" | "service"
  statusCode: number | null
  latencyMs: number | null
  assertionResults: unknown[]
  safeResponseSummary: string
  errorMessage: string
}

export type LegacyEndpointRun = {
  id: string
  projectId: string
  journeyId: string
  journeyVersionId: null
  trigger: "legacy_endpoint_monitor"
  status: "finalized"
  verdict: "passed" | "degraded" | "failed" | "inconclusive"
  source: "legacy_endpoint"
  runnerProvider: "deterministic_endpoint_monitor"
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  summary: string
  businessImpact: string
  cleanupStatus: "not_applicable"
  cleanupErrorSummary: ""
  cancelRequestedAt: null
  stageEvidenceAvailable: false
  stages: []
  evidence: []
  legacyEndpointEvidence: LegacyEndpointEvidence
  createdAt: string
  updatedAt: string
}

export function legacyEndpointVerdict(status: unknown): LegacyEndpointRun["verdict"] {
  if (status === "healthy") return "passed"
  if (status === "degraded") return "degraded"
  if (status === "failed") return "failed"
  return "inconclusive"
}

export function presentLegacyEndpointRun(
  row: LegacyEndpointRunRow,
  checkName = "Legacy endpoint check"
): LegacyEndpointRun {
  const verdict = legacyEndpointVerdict(row.status)
  const latencyMs = finiteNumber(row.latency_ms)
  const startedAt = nullableString(row.started_at)
  const completedAt = nullableString(row.completed_at)
  const safeResponseSummary = cleanText(row.safe_response_summary)
  const errorMessage = cleanText(row.error_message)
  const createdAt = cleanText(row.created_at) || startedAt || completedAt || ""

  return {
    id: cleanText(row.id),
    projectId: cleanText(row.client_id),
    journeyId: cleanText(row.workflow_id),
    journeyVersionId: null,
    trigger: "legacy_endpoint_monitor",
    status: "finalized",
    verdict,
    source: "legacy_endpoint",
    runnerProvider: "deterministic_endpoint_monitor",
    startedAt,
    completedAt,
    durationMs: latencyMs ?? elapsedMilliseconds(startedAt, completedAt),
    summary: errorMessage || safeResponseSummary || legacySummary(verdict),
    businessImpact: legacyBusinessImpact(verdict),
    cleanupStatus: "not_applicable",
    cleanupErrorSummary: "",
    cancelRequestedAt: null,
    stageEvidenceAvailable: false,
    stages: [],
    evidence: [],
    legacyEndpointEvidence: {
      checkId: cleanText(row.check_id),
      checkName: cleanText(checkName) || "Legacy endpoint check",
      evidenceOrigin: row.evidence_origin === "service" ? "service" : "legacy_browser",
      statusCode: finiteNumber(row.status_code),
      latencyMs,
      assertionResults: Array.isArray(row.assertion_results_json) ? row.assertion_results_json : [],
      safeResponseSummary,
      errorMessage,
    },
    createdAt,
    updatedAt: completedAt || createdAt,
  }
}

export function legacyEndpointRunTime(row: object) {
  const value = row as LegacyEndpointRunRow
  return sortableTime(value.createdAt ?? value.created_at ?? value.startedAt ?? value.started_at)
}

export function mergeLegacyEndpointHistory<T extends object, U extends object>(
  evalRows: T[],
  legacyRows: U[],
  offset: number,
  limit: number
) {
  const merged = [...evalRows, ...legacyRows]
    .sort((left, right) => legacyEndpointRunTime(right) - legacyEndpointRunTime(left))
  return {
    rows: merged.slice(offset, offset + limit),
    hasMore: merged.length > offset + limit,
  }
}

export function isLegacyEndpointIncident(row: LegacyEndpointRunRow) {
  return !row.eval_run_id && !row.eval_stage_run_id && !row.verification_eval_run_id
}

export function legacyReportMetrics(row: LegacyEndpointRunRow) {
  const snapshot = objectValue(row.snapshot_json)
  const snapshotMetrics = objectValue(snapshot.metrics)
  const metrics = Object.keys(snapshotMetrics).length ? snapshotMetrics : objectValue(row.metrics_json)
  const workflowCoverage = Array.isArray(snapshot.workflowCoverage) ? snapshot.workflowCoverage : []
  const workflowIds = Array.isArray(snapshot.workflowIds) ? snapshot.workflowIds : []
  const journeysCovered = numberValue(
    metrics.journeysCovered,
    numberValue(metrics.workflowsMonitored, workflowCoverage.length || workflowIds.length)
  )
  const checksRun = numberValue(metrics.evalRuns, numberValue(metrics.checksRun, 0))
  const passedRuns = numberValue(metrics.passedRuns, 0)
  const passRate = numberValue(metrics.passRate, checksRun ? (passedRuns / checksRun) * 100 : 0)

  return {
    metrics,
    journeysCovered,
    checksRun,
    passRate,
    incidentsResolved: numberValue(metrics.incidentsResolved, numberValue(metrics.issuesResolved, 0)),
    source: row.eval_snapshot_idempotency_key ? "business_eval" as const : "legacy_endpoint" as const,
  }
}

function legacySummary(verdict: LegacyEndpointRun["verdict"]) {
  if (verdict === "passed") return "The deterministic endpoint check passed."
  if (verdict === "degraded") return "The endpoint responded but exceeded an approved legacy threshold."
  if (verdict === "failed") return "The deterministic endpoint assertion failed."
  return "The legacy endpoint monitor could not produce a conclusive result."
}

function legacyBusinessImpact(verdict: LegacyEndpointRun["verdict"]) {
  if (verdict === "passed") return "No endpoint availability issue was detected."
  if (verdict === "degraded") return "The endpoint remained available, but its response quality or timing degraded."
  if (verdict === "failed") return "The monitored endpoint did not meet its configured deterministic assertion."
  return "Endpoint availability was not proven by this run."
}

function elapsedMilliseconds(startedAt: string | null, completedAt: string | null) {
  if (!startedAt || !completedAt) return null
  const value = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(value) && value >= 0 ? value : null
}

function sortableTime(value: unknown) {
  const milliseconds = new Date(cleanText(value)).getTime()
  return Number.isFinite(milliseconds) ? milliseconds : 0
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function nullableString(value: unknown) {
  const text = cleanText(value)
  return text || null
}

function finiteNumber(value: unknown) {
  const parsed = Number(value)
  return value !== null && value !== "" && Number.isFinite(parsed) ? parsed : null
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function objectValue(value: unknown): LegacyEndpointRunRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LegacyEndpointRunRow : {}
}
