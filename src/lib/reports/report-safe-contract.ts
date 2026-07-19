export type ReportContractSource = "business_eval" | "legacy_endpoint"

export type ReportSafeMetrics = {
  journeysCovered: number
  evalRuns: number
  passedRuns: number
  passRate: number
  incidents: number
  recoveries: number
}

export type ReportJourneyCoverage = {
  journeyId: string
  name: string
  template: "lead_form" | "trial_signup" | "legacy_endpoint"
  runCount: number
  latestVerdict: ReportVerdict
  latestCompletedAt: string | null
}

export type ReportIncidentSummary = {
  incidentId: string
  journeyId: string
  sourceEvalRunId: string | null
  verificationEvalRunId: string | null
  severity: "critical" | "high" | "medium" | "low"
  status: "open" | "in_review" | "snoozed" | "resolved" | "ignored"
  title: string
  reportSafeSummary: string
  createdAt: string
  resolvedAt: string | null
}

export type ReportSafeArtifactSummary = {
  artifactId: string
  kind: "screenshot"
  mimeType: "image/png" | "image/jpeg"
}

export type ReportStageEvidenceSummary = {
  position: number
  verdict: ReportVerdict
  expected: string
  errorCode: string | null
  durationMs: number | null
  artifacts: ReportSafeArtifactSummary[]
}

export type ReportEvidenceSummary = {
  runId: string
  journeyId: string
  verdict: ReportVerdict
  summary: string
  businessImpact: string
  cleanupStatus: "pending" | "passed" | "failed" | "not_required" | "skipped"
  completedAt: string
  durationMs: number | null
  stages: ReportStageEvidenceSummary[]
}

export type ReportProvenance = {
  source: ReportContractSource
  schemaVersion: number
  snapshotVersion: number
  generatedAt: string
  evidenceFingerprint: string
}

export type ReportSafeContent = {
  summary: string
  metrics: ReportSafeMetrics
  coverage: {
    journeys: ReportJourneyCoverage[]
    journeysCovered: number
    source: ReportContractSource
  }
  incidents: ReportIncidentSummary[]
  recoveries: ReportIncidentSummary[]
  evidenceSummaries: ReportEvidenceSummary[]
  provenance: ReportProvenance
}

type ReportVerdict = "passed" | "degraded" | "failed" | "inconclusive" | "cancelled" | "not_run"
type Row = Record<string, unknown>

const verdicts = new Set<ReportVerdict>(["passed", "degraded", "failed", "inconclusive", "cancelled", "not_run"])
const templates = new Set<ReportJourneyCoverage["template"]>(["lead_form", "trial_signup", "legacy_endpoint"])
const severities = new Set<ReportIncidentSummary["severity"]>(["critical", "high", "medium", "low"])
const incidentStatuses = new Set<ReportIncidentSummary["status"]>(["open", "in_review", "snoozed", "resolved", "ignored"])
const cleanupStatuses = new Set<ReportEvidenceSummary["cleanupStatus"]>(["pending", "passed", "failed", "not_required", "skipped"])
const screenshotMimeTypes = new Set<ReportSafeArtifactSummary["mimeType"]>(["image/png", "image/jpeg"])

/**
 * Converts an immutable report snapshot into the only report payload that may
 * leave the server. This is deliberately an allowlist: unknown snapshot keys,
 * traces, raw email, storage paths and private diagnostic material are never
 * copied into either the authenticated or public report contract.
 */
export function buildReportSafeContent(input: {
  snapshot: unknown
  source: ReportContractSource
  snapshotVersion: number
  evidenceFingerprint: string
  fallbackSummary?: unknown
  fallbackMetrics?: unknown
  fallbackJourneysCovered?: number
  generatedAt?: unknown
}): ReportSafeContent {
  const snapshot = asRow(input.snapshot)
  const snapshotMetrics = asRow(snapshot.metrics)
  const fallbackMetrics = asRow(input.fallbackMetrics)
  const metricSource = Object.keys(snapshotMetrics).length ? snapshotMetrics : fallbackMetrics
  const journeys = asRows(snapshot.journeys).map((row) => journeyCoverage(row, input.source)).filter(isPresent)
  const incidents = asRows(snapshot.incidents).map(incidentSummary).filter(isPresent)
  const recoveries = incidents.filter((incident) =>
    incident.status === "resolved"
    && Boolean(incident.verificationEvalRunId)
    && Boolean(incident.resolvedAt)
  )
  const evidenceSummaries = asRows(snapshot.runs).map(evidenceSummary).filter(isPresent)
  const journeysCovered = nonnegativeInteger(
    metricSource.journeysCovered,
    input.fallbackJourneysCovered ?? journeys.length
  )

  return {
    summary: safeText(snapshot.summary ?? snapshot.narrative ?? input.fallbackSummary, 4_000),
    metrics: {
      journeysCovered,
      evalRuns: nonnegativeInteger(metricSource.evalRuns ?? metricSource.checksRun, evidenceSummaries.length),
      passedRuns: nonnegativeInteger(metricSource.passedRuns, evidenceSummaries.filter((run) => run.verdict === "passed").length),
      passRate: boundedNumber(metricSource.passRate, 0, 100),
      incidents: incidents.length,
      recoveries: recoveries.length,
    },
    coverage: {
      journeys,
      journeysCovered,
      source: input.source,
    },
    incidents,
    recoveries,
    evidenceSummaries,
    provenance: {
      source: input.source,
      schemaVersion: nonnegativeInteger(snapshot.schemaVersion, input.source === "business_eval" ? 1 : 0),
      snapshotVersion: nonnegativeInteger(input.snapshotVersion, 0),
      generatedAt: safeText(snapshot.generatedAt ?? input.generatedAt, 100),
      evidenceFingerprint: safeFingerprint(input.evidenceFingerprint),
    },
  }
}

function journeyCoverage(row: Row, source: ReportContractSource): ReportJourneyCoverage | null {
  const journeyId = safeIdentifier(row.journeyId ?? row.workflowId ?? row.id)
  if (!journeyId) return null
  return {
    journeyId,
    name: safeText(row.name, 300) || "Journey",
    template: enumValue(templates, row.template, source === "legacy_endpoint" ? "legacy_endpoint" : "lead_form"),
    runCount: nonnegativeInteger(row.runCount, 0),
    latestVerdict: enumValue(verdicts, row.latestVerdict, "inconclusive"),
    latestCompletedAt: nullableText(row.latestCompletedAt, 100),
  }
}

function incidentSummary(row: Row): ReportIncidentSummary | null {
  const incidentId = safeIdentifier(row.incidentId ?? row.id)
  const journeyId = safeIdentifier(row.journeyId ?? row.workflowId)
  if (!incidentId || !journeyId) return null
  return {
    incidentId,
    journeyId,
    sourceEvalRunId: nullableIdentifier(row.sourceEvalRunId),
    verificationEvalRunId: nullableIdentifier(row.verificationEvalRunId),
    severity: enumValue(severities, row.severity, "medium"),
    status: enumValue(incidentStatuses, row.status, "open"),
    title: safeText(row.title, 300) || "Journey incident",
    reportSafeSummary: safeText(row.reportSafeSummary, 4_000),
    createdAt: safeText(row.createdAt, 100),
    resolvedAt: nullableText(row.resolvedAt, 100),
  }
}

function evidenceSummary(row: Row): ReportEvidenceSummary | null {
  const runId = safeIdentifier(row.runId ?? row.id)
  const journeyId = safeIdentifier(row.journeyId ?? row.workflowId)
  if (!runId || !journeyId) return null
  return {
    runId,
    journeyId,
    verdict: enumValue(verdicts, row.verdict, "inconclusive"),
    summary: safeText(row.summary, 4_000),
    businessImpact: safeText(row.businessImpact, 4_000),
    cleanupStatus: enumValue(cleanupStatuses, row.cleanupStatus, "pending"),
    completedAt: safeText(row.completedAt, 100),
    durationMs: nullableNonnegativeInteger(row.durationMs),
    stages: asRows(row.stages).map(stageEvidenceSummary).filter(isPresent),
  }
}

function stageEvidenceSummary(row: Row): ReportStageEvidenceSummary | null {
  const position = nonnegativeInteger(row.position, -1)
  if (position < 0) return null
  return {
    position,
    verdict: enumValue(verdicts, row.verdict, "inconclusive"),
    expected: safeText(row.expected, 2_000),
    errorCode: nullableText(row.errorCode, 160),
    durationMs: nullableNonnegativeInteger(row.durationMs),
    artifacts: asRows(row.artifacts).map(reportSafeArtifact).filter(isPresent),
  }
}

function reportSafeArtifact(row: Row): ReportSafeArtifactSummary | null {
  const artifactId = safeIdentifier(row.artifactId ?? row.id)
  if (!artifactId || row.kind !== "screenshot" || !screenshotMimeTypes.has(row.mimeType as ReportSafeArtifactSummary["mimeType"])) return null
  return { artifactId, kind: "screenshot", mimeType: row.mimeType as ReportSafeArtifactSummary["mimeType"] }
}

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

function asRows(value: unknown) {
  return Array.isArray(value) ? value.map(asRow) : []
}

function safeText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : ""
}

function nullableText(value: unknown, maximum: number) {
  const text = safeText(value, maximum)
  return text || null
}

function safeIdentifier(value: unknown) {
  return safeText(value, 160)
}

function nullableIdentifier(value: unknown) {
  const identifier = safeIdentifier(value)
  return identifier || null
}

function nonnegativeInteger(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function nullableNonnegativeInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : minimum
}

function enumValue<T extends string>(allowed: Set<T>, value: unknown, fallback: T) {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback
}

function safeFingerprint(value: unknown) {
  const fingerprint = safeText(value, 64).toLowerCase()
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : ""
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}
