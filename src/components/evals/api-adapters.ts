import { businessEvalsRequest, createIdempotencyKey } from "@/lib/api/business-evals-client"
import type { JourneyDraftInput } from "@/lib/api/business-evals-contracts"
import {
  businessEvalsAccessResponseSchema,
  enqueuedEvalRunResponseSchema,
  evalRunCancellationResponseSchema,
  incidentResponseSchema,
  journeyResponseSchema,
  verificationEnqueuedEvalRunResponseSchema,
} from "@/lib/api/business-evals-response-schemas"
import type {
  ReportEvidenceSummary,
  ReportIncidentSummary,
  ReportJourneyCoverage,
  ReportProvenance,
  ReportSafeArtifactSummary,
  ReportStageEvidenceSummary,
} from "@/lib/reports/report-safe-contract"
import type { EvalReport, EvalRun, Incident, IncidentMutation, InteractiveEvalRunMode, Journey, Project } from "./types"

export type BusinessEvalsRow = Record<string, unknown>
type Row = BusinessEvalsRow

export async function probeBusinessEvalsAccess() {
  return (await businessEvalsRequest("/api/business-evals/access", businessEvalsAccessResponseSchema)).data
}

export function productionHooks(workspaceId: string) {
  const scoped = { workspaceId }
  return {
    createJourney: async (draft: JourneyDraftInput) => mapJourney((await businessEvalsRequest("/api/journeys", journeyResponseSchema, { ...scoped, method: "POST", body: JSON.stringify(draft) })).data, null),
    updateJourney: async (id: string, draft: JourneyDraftInput) => mapJourney((await businessEvalsRequest(`/api/journeys/${encodeURIComponent(id)}`, journeyResponseSchema, { ...scoped, method: "PATCH", body: JSON.stringify(draft) })).data, null),
    runJourney: async (id: string, mode: InteractiveEvalRunMode) => {
      const retryScope = `eval-run:${workspaceId}:${id}:${mode}`
      const idempotencyKey = pendingIdempotencyKey(retryScope)
      const data = (await businessEvalsRequest("/api/eval-runs", enqueuedEvalRunResponseSchema, {
        ...scoped,
        method: "POST",
        idempotencyKey,
        body: JSON.stringify({ journeyId: id, mode }),
      })).data
      clearPendingIdempotencyKey(retryScope, idempotencyKey)
      return mapEnqueuedRun(data, id, mode)
    },
    mutateIncident: async (id: string, mutation: IncidentMutation) => {
      const responseSchema = mutation.action === "verify" ? verificationEnqueuedEvalRunResponseSchema : incidentResponseSchema
      const data = (await businessEvalsRequest(`/api/incidents/${encodeURIComponent(id)}`, responseSchema, {
        ...scoped,
        method: "PATCH",
        idempotencyKey: createIdempotencyKey(`incident:${id}:${mutation.action}`),
        body: JSON.stringify(mutation),
      })).data
      return mutation.action === "verify"
        ? mapEnqueuedRun(data, stringValue(data.journeyId), "verification")
        : mapIncident(data)
    },
    cancelRun: async (id: string) => {
      const retryScope = `eval-cancel:${workspaceId}:${id}`
      const idempotencyKey = pendingIdempotencyKey(retryScope)
      const data = (await businessEvalsRequest(`/api/eval-runs/${encodeURIComponent(id)}`, evalRunCancellationResponseSchema, {
        ...scoped,
        method: "DELETE",
        idempotencyKey,
      })).data
      clearPendingIdempotencyKey(retryScope, idempotencyKey)
      return { id: stringValue(data.id, id), cancelRequestedAt: stringValue(data.cancelRequestedAt) }
    },
    pauseJourney: async (id: string, reason: string) => mapJourney((await businessEvalsRequest(`/api/journeys/${encodeURIComponent(id)}/pause`, journeyResponseSchema, {
      ...scoped,
      method: "POST",
      body: JSON.stringify({ reason }),
    })).data, null),
    resumeJourney: async (id: string) => mapJourney((await businessEvalsRequest(`/api/journeys/${encodeURIComponent(id)}/resume`, journeyResponseSchema, {
      ...scoped,
      method: "POST",
    })).data, null),
    configureJourneySchedule: async (id: string, enabled: boolean, intervalMinutes: number) => mapJourney((await businessEvalsRequest(`/api/journeys/${encodeURIComponent(id)}/schedule`, journeyResponseSchema, {
      ...scoped,
      method: "POST",
      body: JSON.stringify({ enabled, intervalMinutes }),
    })).data, null),
  }
}

const inMemoryIdempotencyKeys = new Map<string, string>()
const idempotencyStoragePrefix = "maintainflow:pending-idempotency:"

export function pendingIdempotencyKey(scope: string) {
  const storageKey = `${idempotencyStoragePrefix}${scope}`
  const stored = readPendingIdempotencyKey(storageKey)
  if (stored) return stored
  const created = createIdempotencyKey(scope)
  inMemoryIdempotencyKeys.set(storageKey, created)
  try {
    window.sessionStorage.setItem(storageKey, created)
  } catch {
    // The in-memory fallback still keeps retries stable when storage is blocked.
  }
  return created
}

function readPendingIdempotencyKey(storageKey: string) {
  try {
    const stored = window.sessionStorage.getItem(storageKey)
    if (stored) {
      inMemoryIdempotencyKeys.set(storageKey, stored)
      return stored
    }
  } catch {
    // Fall through to the per-session in-memory value.
  }
  return inMemoryIdempotencyKeys.get(storageKey) ?? ""
}

export function clearPendingIdempotencyKey(scope: string, completedKey: string) {
  const storageKey = `${idempotencyStoragePrefix}${scope}`
  if (inMemoryIdempotencyKeys.get(storageKey) === completedKey) inMemoryIdempotencyKeys.delete(storageKey)
  try {
    if (window.sessionStorage.getItem(storageKey) === completedKey) window.sessionStorage.removeItem(storageKey)
  } catch {
    // A successful response is already enough to clear the in-memory retry key.
  }
}

export function mapProject(row: Row, journeyIds: string[] = []): Project {
  const website = stringValue(row.website)
  const authorization = isRow(row.authorization) ? row.authorization : null
  const authorizationActor = isRow(authorization?.actor) ? authorization.actor : null
  const ownerName = stringValue(row.ownerName)
  const ownerEmail = stringValue(row.ownerEmail)
  return {
    id: stringValue(row.id),
    name: stringValue(row.name, "Untitled project"),
    domain: hostname(website),
    description: projectKindDescription(stringValue(row.kind, "client_site")),
    environment: "Production",
    owner: ownerName || ownerEmail || (row.ownerUserId ? "Workspace member" : "Unassigned"),
    journeyIds,
    updatedAt: formatDateTime(stringValue(row.updatedAt)),
    website,
    kind: normalizeProjectKind(stringValue(row.kind)),
    ownerUserId: nullableString(row.ownerUserId),
    ownerEmail,
    reportRecipientEmail: stringValue(row.reportRecipientEmail),
    notes: stringValue(row.notes),
    lastRunAt: row.lastRunAt ? formatDateTime(stringValue(row.lastRunAt)) : "Not run yet",
    health: normalizeProjectHealth(stringValue(row.health)),
    activeJourneys: numberValue(row.activeJourneys, journeyIds.length),
    openIncidents: numberValue(row.openIncidents, 0),
    reportStatus: nullableString(row.reportStatus),
    legacyEndpointJourneys: numberValue(row.legacyEndpointJourneys, 0),
    businessEvalJourneys: numberValue(row.businessEvalJourneys, 0),
    archivedAt: nullableString(row.archivedAt),
    authorization: authorization ? {
      id: stringValue(authorization.id),
      domain: stringValue(authorization.domain),
      approvedActionDomains: arrayOfStrings(authorization.approvedActionDomains),
      attestationVersion: stringValue(authorization.attestationVersion),
      actor: {
        userId: stringValue(authorizationActor?.userId),
        name: stringValue(authorizationActor?.name, "Workspace member"),
        email: stringValue(authorizationActor?.email),
      },
      recordedAt: formatDateTime(stringValue(authorization.recordedAt)),
      revokedAt: authorization.revokedAt ? formatDateTime(stringValue(authorization.revokedAt)) : null,
      state: authorization.state === "current" ? "current" : "revoked",
    } : null,
  }
}

export function mapJourney(row: Row, latestRun: Row | null = null): Journey {
  const template = normalizeTemplate(stringValue(row.template))
  const draft = isRow(row.draft) ? row.draft : {}
  const rawDraft = normalizeDraft(row, draft, template)
  const definitionStages = arrayOfRows(row.stages)
  const runStages = arrayOfRows(latestRun?.stages)
  const latestVerdict = latestRun ? statusValue(latestRun.verdict || latestRun.status) : statusValue(row.lastVerdict || row.status)
  const stages = definitionStages.length
    ? definitionStages.map((stage, index) => {
        const stageId = stringValue(stage.id || stage.stage_key || stage.key, `stage-${index + 1}`)
        const result = runStages.find((candidate) => stringValue(candidate.stage_definition_id || candidate.stageDefinitionId) === stageId || numberValue(candidate.position) === numberValue(stage.position))
        return {
          id: stageId,
          name: stringValue(stage.name, `Stage ${index + 1}`),
          status: statusValue(result?.verdict || result?.status || "not_run"),
          duration: formatDuration(numberValue(result?.duration_ms || result?.durationMs, 0)),
          threshold: numberValue(stage.timing_threshold_ms || stage.timingThresholdMs, 0) ? `Threshold: < ${formatDuration(numberValue(stage.timing_threshold_ms || stage.timingThresholdMs))}` : undefined,
          expected: stringValue(stage.expected_text || stage.expected, "Expected evidence is defined in the published journey."),
          observed: stringValue(result?.observed_text || result?.observedText, result ? "No observed text was recorded." : "This stage has not run yet."),
          impact: stringValue(stage.business_impact || stage.businessImpact, stringValue(latestRun?.businessImpact, "Business impact is recorded with conclusive evidence.")),
          evidenceLabel: arrayOfStrings(result?.evidence_artifact_ids || result?.evidenceArtifactIds).length ? "View evidence" : undefined,
        }
      })
    : template === "legacy_endpoint"
      ? [{ id: "legacy-endpoint-diagnostic", name: "Legacy endpoint diagnostic", status: latestVerdict, expected: "The deterministic endpoint assertion meets its configured status, response and timing thresholds.", observed: "No browser stage evidence exists for legacy endpoint coverage. Open a run to review its safe endpoint diagnostics.", impact: "Summary status reflects the latest conclusive deterministic endpoint check." }]
      : [{ id: "coverage", name: "Journey draft", status: latestVerdict, expected: "Open the journey to load its published stages.", observed: "Stage evidence loads on the journey detail route.", impact: "Summary status reflects the latest conclusive run." }]
  const scheduleRow = isRow(row.schedule) ? row.schedule : {}
  const interval = numberValue(scheduleRow.interval_minutes || scheduleRow.intervalMinutes || row.schedule, 0)
  const scheduleEnabled = typeof row.scheduleEnabled === "boolean"
    ? row.scheduleEnabled
    : Boolean(scheduleRow.enabled)
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.projectId),
    projectName: stringValue(row.projectName),
    template,
    name: stringValue(row.name, "Untitled journey"),
    description: journeyDescription(template, stringValue(row.startUrl || rawDraft?.startUrl)),
    status: latestVerdict,
    schedule: scheduleEnabled && interval ? scheduleLabel(interval) : "Not scheduled",
    owner: "Workspace team",
    environment: "Production",
    lastRunAt: formatDateTime(stringValue(latestRun?.startedAt || row.lastRunAt)),
    stages,
    startUrl: stringValue(row.startUrl || rawDraft?.startUrl),
    draftRevision: numberValue(row.draftRevision, 0),
    published: Boolean(row.publishedVersionId || row.published),
    rawDraft,
    source: row.source === "legacy_endpoint" || template === "legacy_endpoint" ? "legacy_endpoint" : "business_eval",
    stageEvidenceAvailable: row.stageEvidenceAvailable !== false && template !== "legacy_endpoint",
    pausedAt: nullableString(row.pausedAt),
    pauseReason: stringValue(row.pauseReason),
    scheduleEnabled,
    supervisedRunId: nullableString(scheduleRow.supervised_run_id || scheduleRow.supervisedRunId || row.supervisedRunId),
    cleanupVerified: Boolean(scheduleRow.cleanup_verified || scheduleRow.cleanupVerified || row.cleanupVerified),
    schedulePausedAt: nullableString(scheduleRow.paused_at || scheduleRow.pausedAt || row.schedulePausedAt),
    schedulePauseReason: stringValue(scheduleRow.pause_reason || scheduleRow.pauseReason || row.schedulePauseReason),
    archivedAt: nullableString(row.archivedAt),
  }
}

export function mapRun(row: Row): EvalRun {
  const lifecycle = stringValue(row.status).toLowerCase()
  const status = lifecycle === "queued" || lifecycle === "claimed"
    ? "queued"
    : lifecycle === "running" || lifecycle === "waiting_for_email"
      ? "running"
      : statusValue(row.verdict || row.status)
  const stages = arrayOfRows(row.stages)
  const evidence = arrayOfRows(row.evidence)
  const legacyEndpointEvidence = isRow(row.legacyEndpointEvidence) ? row.legacyEndpointEvidence : null
  return {
    id: stringValue(row.id),
    journeyId: stringValue(row.journeyId),
    journeyName: stringValue(row.journeyName),
    startedAt: formatDateTime(stringValue(row.startedAt || row.createdAt)),
    status,
    duration: formatDuration(numberValue(row.durationMs, 0)),
    impact: stringValue(row.businessImpact, status === "passed" ? "None" : "Review captured evidence"),
    triggeredBy: labelize(stringValue(row.trigger, "manual")),
    journeyVersionId: stringValue(row.journeyVersionId) || undefined,
    runnerProvider: stringValue(row.runnerProvider) || undefined,
    completedAt: row.completedAt ? formatDateTime(stringValue(row.completedAt)) : undefined,
    summary: stringValue(row.summary) || undefined,
    cleanupStatus: stringValue(row.cleanupStatus) || undefined,
    cleanupErrorSummary: stringValue(row.cleanupErrorSummary) || undefined,
    cancelRequestedAt: nullableString(row.cancelRequestedAt),
    stageEvidence: stages.length ? stages.map((stage) => ({
      id: stringValue(stage.id),
      definitionId: stringValue(stage.stage_definition_id || stage.stageDefinitionId),
      position: numberValue(stage.position, 0),
      status: statusValue(stage.status),
      verdict: statusValue(stage.verdict || stage.status),
      expected: stringValue(stage.expected_text || stage.expectedText, "No expected text was recorded."),
      observed: stringValue(stage.observed_text || stage.observedText, "No observed text was recorded."),
      errorCode: stringValue(stage.error_code || stage.errorCode),
      diagnostics: stage.diagnostics_json ?? stage.diagnosticsJson ?? {},
      assertions: Array.isArray(stage.assertion_results_json || stage.assertionResultsJson)
        ? (stage.assertion_results_json || stage.assertionResultsJson) as unknown[]
        : [],
      evidenceArtifactIds: arrayOfStrings(stage.evidence_artifact_ids || stage.evidenceArtifactIds),
      startedAt: stage.started_at || stage.startedAt ? formatDateTime(stringValue(stage.started_at || stage.startedAt)) : "Not started",
      completedAt: stage.completed_at || stage.completedAt ? formatDateTime(stringValue(stage.completed_at || stage.completedAt)) : "Not completed",
      duration: formatDuration(numberValue(stage.duration_ms || stage.durationMs, 0)),
    })) : undefined,
    evidenceArtifacts: evidence.length ? evidence.map((artifact) => ({
      id: stringValue(artifact.id),
      stageRunId: stringValue(artifact.eval_stage_run_id || artifact.evalStageRunId),
      kind: stringValue(artifact.artifact_kind || artifact.artifactKind, "artifact"),
      mimeType: stringValue(artifact.mime_type || artifact.mimeType),
      byteSize: numberValue(artifact.byte_size || artifact.byteSize, 0),
      sha256: stringValue(artifact.sha256),
      redacted: Boolean(artifact.redacted),
      expiresAt: artifact.expires_at || artifact.expiresAt ? formatDateTime(stringValue(artifact.expires_at || artifact.expiresAt)) : "No expiry recorded",
      createdAt: artifact.created_at || artifact.createdAt ? formatDateTime(stringValue(artifact.created_at || artifact.createdAt)) : "Not recorded",
    })) : undefined,
    source: row.source === "legacy_endpoint" ? "legacy_endpoint" : "business_eval",
    stageEvidenceAvailable: row.stageEvidenceAvailable !== false,
    legacyEndpointEvidence: legacyEndpointEvidence ? {
      checkId: stringValue(legacyEndpointEvidence.checkId),
      checkName: stringValue(legacyEndpointEvidence.checkName, "Legacy endpoint check"),
      evidenceOrigin: legacyEndpointEvidence.evidenceOrigin === "service" ? "service" : "legacy_browser",
      statusCode: nullableNumber(legacyEndpointEvidence.statusCode),
      latencyMs: nullableNumber(legacyEndpointEvidence.latencyMs),
      assertionResults: Array.isArray(legacyEndpointEvidence.assertionResults) ? legacyEndpointEvidence.assertionResults : [],
      safeResponseSummary: stringValue(legacyEndpointEvidence.safeResponseSummary),
      errorMessage: stringValue(legacyEndpointEvidence.errorMessage),
    } : undefined,
  }
}

export function mapEnqueuedRun(row: Row, journeyId: string, mode: string): EvalRun {
  return { id: stringValue(row.id), journeyId, startedAt: "Queued just now", status: "queued", duration: "Queued", impact: "Evaluation pending", triggeredBy: labelize(mode) }
}

export function mapIncident(row: Row): Incident {
  const severity = normalizeSeverity(stringValue(row.severity))
  return {
    id: stringValue(row.id),
    journeyId: stringValue(row.journeyId),
    journeyName: stringValue(row.journeyName),
    title: stringValue(row.title, "Journey incident"),
    summary: stringValue(row.description, "Review the linked eval evidence."),
    status: normalizeIncidentStatus(stringValue(row.status)),
    severity,
    openedAt: formatDateTime(stringValue(row.createdAt)),
    owner: row.ownerUserId ? "Assigned workspace member" : "Unassigned",
    impact: stringValue(row.reportSafeSummary || row.suggestedAction, severity === "high" || severity === "critical" ? "A critical business outcome needs attention." : "Review the captured business impact."),
    repairNote: stringValue(row.repairNote),
    ownerUserId: nullableString(row.ownerUserId),
    source: row.source === "legacy_endpoint" ? "legacy_endpoint" : "business_eval",
  }
}

export function mapReport(row: Row): EvalReport {
  const metrics = isRow(row.metrics) ? row.metrics : {}
  const coverage = isRow(row.coverage) ? row.coverage : {}
  const provenance = isRow(row.provenance) ? row.provenance : {}
  const periodStart = stringValue(row.periodStart)
  const periodEnd = stringValue(row.periodEnd)
  const shares = Array.isArray(row.shares) ? row.shares.filter(isRow).map((share) => ({
    id: stringValue(share.id),
    snapshotVersion: numberValue(share.snapshot_version || share.snapshotVersion, 0),
    expiresAt: stringValue(share.expires_at || share.expiresAt),
    revokedAt: nullableString(share.revoked_at || share.revokedAt),
    accessCount: numberValue(share.access_count || share.accessCount, 0),
    lastAccessedAt: nullableString(share.last_accessed_at || share.lastAccessedAt),
    createdAt: stringValue(share.created_at || share.createdAt),
  })) : []
  const source = row.source === "legacy_endpoint" ? "legacy_endpoint" as const : "business_eval" as const
  const hasActiveShare = typeof row.hasActiveShare === "boolean"
    ? row.hasActiveShare
    : shares.some((share) => !share.revokedAt && (!share.expiresAt || new Date(share.expiresAt).getTime() > Date.now()))
  const rawStatus = stringValue(row.status).toLowerCase()
  const status: EvalReport["status"] = source === "legacy_endpoint"
    ? rawStatus === "sent" ? "sent" : rawStatus === "blocked" ? "blocked" : rawStatus === "ready" ? "ready" : "draft"
    : rawStatus === "ready" ? (hasActiveShare ? "shared" : "ready") : "draft"
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.projectId),
    projectName: stringValue(row.projectName),
    title: stringValue(row.title, source === "legacy_endpoint" ? "Legacy endpoint report" : "Business eval report"),
    period: periodStart && periodEnd ? `${formatDate(periodStart)}–${formatDate(periodEnd)}` : "Reporting period",
    status,
    createdAt: formatDateTime(stringValue(row.createdAt)),
    passRate: percentValue(metrics.passRate || metrics.pass_rate),
    journeysCovered: numberValue(coverage.journeysCovered || coverage.journeys_covered || metrics.journeysCovered, 0),
    incidentsResolved: numberValue(metrics.recoveries || metrics.incidentsResolved || metrics.incidents_resolved, 0),
    summary: stringValue(row.summary, "Business journey evidence for the selected reporting period."),
    snapshotVersion: numberValue(row.snapshotVersion, 0),
    staleAt: nullableString(row.staleAt),
    pdfReady: Boolean(row.pdfReady),
    rawMetrics: metrics,
    reportMetrics: {
      journeysCovered: numberValue(metrics.journeysCovered, 0),
      evalRuns: numberValue(metrics.evalRuns, 0),
      passedRuns: numberValue(metrics.passedRuns, 0),
      passRate: numberValue(metrics.passRate, 0),
      incidents: numberValue(metrics.incidents, 0),
      recoveries: numberValue(metrics.recoveries, 0),
    },
    journeyCoverage: arrayOfRows(coverage.journeys).map(mapReportJourneyCoverage),
    reportIncidents: arrayOfRows(row.incidents).map(mapReportIncidentSummary),
    verifiedRecoveries: arrayOfRows(row.recoveries).map(mapReportIncidentSummary),
    evidenceSummaries: arrayOfRows(row.evidenceSummaries).map(mapReportEvidenceSummary),
    provenance: mapReportProvenance(provenance, source, numberValue(row.snapshotVersion, 0)),
    evidenceFingerprint: stringValue(row.evidenceFingerprint),
    shares,
    source,
    evidenceModel: source === "legacy_endpoint" ? "Legacy endpoint" : "Business eval",
    shareEligible: typeof row.shareEligible === "boolean" ? row.shareEligible : source === "business_eval",
    coverageDisclosure: stringValue(row.coverageDisclosure, source === "legacy_endpoint"
      ? "Historical deterministic endpoint-monitor evidence. This report does not contain browser-stage, email, screenshot, or cleanup proof."
      : "Business-eval journey evidence only. Legacy endpoint checks are not represented as browser-stage evidence in this snapshot."),
  }
}

function mapReportJourneyCoverage(row: Row): ReportJourneyCoverage {
  return {
    journeyId: stringValue(row.journeyId),
    name: stringValue(row.name, "Journey"),
    template: normalizeTemplate(stringValue(row.template)),
    runCount: numberValue(row.runCount, 0),
    latestVerdict: reportVerdict(row.latestVerdict),
    latestCompletedAt: nullableString(row.latestCompletedAt),
  }
}

function mapReportIncidentSummary(row: Row): ReportIncidentSummary {
  return {
    incidentId: stringValue(row.incidentId),
    journeyId: stringValue(row.journeyId),
    sourceEvalRunId: nullableString(row.sourceEvalRunId),
    verificationEvalRunId: nullableString(row.verificationEvalRunId),
    severity: reportSeverity(row.severity),
    status: normalizeIncidentStatus(stringValue(row.status)),
    title: stringValue(row.title, "Journey incident"),
    reportSafeSummary: stringValue(row.reportSafeSummary),
    createdAt: stringValue(row.createdAt),
    resolvedAt: nullableString(row.resolvedAt),
  }
}

function mapReportEvidenceSummary(row: Row): ReportEvidenceSummary {
  return {
    runId: stringValue(row.runId),
    journeyId: stringValue(row.journeyId),
    verdict: reportVerdict(row.verdict),
    summary: stringValue(row.summary),
    businessImpact: stringValue(row.businessImpact),
    cleanupStatus: reportCleanupStatus(row.cleanupStatus),
    completedAt: stringValue(row.completedAt),
    durationMs: nullableNumber(row.durationMs),
    stages: arrayOfRows(row.stages).map(mapReportStageEvidenceSummary),
  }
}

function mapReportStageEvidenceSummary(row: Row): ReportStageEvidenceSummary {
  return {
    position: numberValue(row.position, 0),
    verdict: reportVerdict(row.verdict),
    expected: stringValue(row.expected),
    errorCode: nullableString(row.errorCode),
    durationMs: nullableNumber(row.durationMs),
    artifacts: arrayOfRows(row.artifacts).map(mapReportSafeArtifact),
  }
}

function mapReportSafeArtifact(row: Row): ReportSafeArtifactSummary {
  return {
    artifactId: stringValue(row.artifactId),
    kind: "screenshot",
    mimeType: row.mimeType === "image/jpeg" ? "image/jpeg" : "image/png",
  }
}

function mapReportProvenance(row: Row, source: "business_eval" | "legacy_endpoint", snapshotVersion: number): ReportProvenance {
  return {
    source,
    schemaVersion: numberValue(row.schemaVersion, source === "business_eval" ? 1 : 0),
    snapshotVersion: numberValue(row.snapshotVersion, snapshotVersion),
    generatedAt: stringValue(row.generatedAt),
    evidenceFingerprint: stringValue(row.evidenceFingerprint),
  }
}

function normalizeDraft(row: Row, draft: Row, template: Journey["template"]): JourneyDraftInput | undefined {
  if (template === "legacy_endpoint") return undefined
  const source = Object.keys(draft).length ? draft : isRow(row.rawDraft) ? row.rawDraft : {}
  const stages = Array.isArray(source.stages) ? source.stages : []
  if (!stages.length) return undefined
  return {
    projectId: stringValue(row.projectId),
    name: stringValue(row.name),
    template,
    startUrl: stringValue(row.startUrl || source.startUrl),
    draftRevision: numberValue(row.draftRevision, 0),
    stages: stages as JourneyDraftInput["stages"],
    emailProofConfigured: Boolean(source.emailProofConfigured),
    cleanupMode: source.cleanupMode === "in_product" || source.cleanupMode === "webhook" ? source.cleanupMode : "none",
  }
}

function isRow(value: unknown): value is Row { return Boolean(value) && typeof value === "object" && !Array.isArray(value) }
function arrayOfRows(value: unknown): Row[] { return Array.isArray(value) ? value.filter(isRow) : [] }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [] }
function stringValue(value: unknown, fallback = "") { return typeof value === "string" && value.trim() ? value : fallback }
function nullableString(value: unknown) { return typeof value === "string" && value.trim() ? value : null }
function numberValue(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function nullableNumber(value: unknown) { const parsed = Number(value); return value === null || value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed }
function hostname(value: string) { try { return new URL(value).hostname } catch { return value || "No website" } }
function labelize(value: string) { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()) }
function percentValue(value: unknown) { const number = numberValue(value, 0); return `${number <= 1 ? Math.round(number * 1000) / 10 : Math.round(number * 10) / 10}%` }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IE", { month: "short", day: "numeric", year: "numeric" }).format(date) }
function formatDateTime(value: string) { if (!value) return "Not run yet"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IE", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date) }
function formatDuration(ms: number) { if (!ms) return "—"; if (ms < 1000) return `${Math.round(ms)} ms`; if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`; return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` }
function scheduleLabel(minutes: number) { return minutes === 1_440 ? "Daily" : minutes % 60 === 0 ? `Every ${minutes / 60} hours` : `Every ${minutes} minutes` }
function statusValue(value: unknown): EvalRun["status"] { const normalized = stringValue(value).toLowerCase(); return ["passed", "degraded", "failed", "inconclusive", "cancelled", "not_run", "queued", "running"].includes(normalized) ? normalized as EvalRun["status"] : normalized === "healthy" ? "passed" : "inconclusive" }
function normalizeTemplate(value: string): Journey["template"] { return value === "trial_signup" ? "trial_signup" : value === "lead_form" ? "lead_form" : "legacy_endpoint" }
function normalizeProjectKind(value: string): Project["kind"] { return value === "own_product" || value === "personal" ? value : "client_site" }
function normalizeProjectHealth(value: string): NonNullable<Project["health"]> { return value === "healthy" || value === "degraded" || value === "failed" ? value : "pending" }
function normalizeSeverity(value: string): Incident["severity"] { return value === "critical" || value === "high" || value === "medium" ? value : "low" }
function normalizeIncidentStatus(value: string): Incident["status"] { return value === "in_review" || value === "snoozed" || value === "resolved" || value === "ignored" ? value : "open" }
function reportVerdict(value: unknown): ReportJourneyCoverage["latestVerdict"] { const normalized = stringValue(value); return normalized === "passed" || normalized === "degraded" || normalized === "failed" || normalized === "cancelled" || normalized === "not_run" ? normalized : "inconclusive" }
function reportSeverity(value: unknown): ReportIncidentSummary["severity"] { const normalized = stringValue(value); return normalized === "critical" || normalized === "high" || normalized === "low" ? normalized : "medium" }
function reportCleanupStatus(value: unknown): ReportEvidenceSummary["cleanupStatus"] { const normalized = stringValue(value); return normalized === "passed" || normalized === "failed" || normalized === "not_required" || normalized === "skipped" ? normalized : "pending" }
function projectKindDescription(kind: string) { return kind === "own_product" ? "Business-critical journeys for an owned SaaS product." : kind === "personal" ? "Public journeys for a personal project." : "Customer-facing journeys maintained for a client site." }
function journeyDescription(template: Journey["template"], startUrl: string) { if (template === "legacy_endpoint") return "Existing endpoint coverage managed by Maintain Flow’s deterministic endpoint monitor."; return `${template === "trial_signup" ? "Trial signup" : "Lead form"} journey beginning at ${hostname(startUrl)}.` }
