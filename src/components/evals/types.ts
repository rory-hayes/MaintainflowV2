import type { JourneyDraftInput } from "@/lib/api/business-evals-contracts"
import type {
  ReportEvidenceSummary,
  ReportIncidentSummary,
  ReportJourneyCoverage,
  ReportProvenance,
  ReportSafeMetrics,
} from "@/lib/reports/report-safe-contract"

export type IncidentMutation =
  | { action: "assign"; ownerUserId: string }
  | { action: "snooze"; until: string }
  | { action: "record_repair"; note: string }
  | { action: "verify" }

export type EvalStatus = "passed" | "degraded" | "failed" | "inconclusive" | "cancelled" | "not_run" | "queued" | "running"

export type ProjectAuthorizationAttestation = {
  id: string
  domain: string
  approvedActionDomains: string[]
  attestationVersion: string
  actor: {
    userId: string
    name: string
    email: string
  }
  recordedAt: string
  revokedAt: string | null
  state: "current" | "revoked"
}

export type Project = {
  id: string
  name: string
  domain: string
  description: string
  environment: "Production" | "Staging"
  owner: string
  journeyIds: string[]
  updatedAt: string
  website?: string
  kind?: "own_product" | "client_site" | "personal"
  ownerUserId?: string | null
  ownerEmail?: string
  reportRecipientEmail?: string
  notes?: string
  lastRunAt?: string
  health?: "healthy" | "degraded" | "failed" | "pending"
  activeJourneys?: number
  openIncidents?: number
  reportStatus?: string | null
  legacyEndpointJourneys?: number
  businessEvalJourneys?: number
  archivedAt?: string | null
  authorization?: ProjectAuthorizationAttestation | null
}

export type JourneyStage = {
  id: string
  name: string
  status: EvalStatus
  duration?: string
  threshold?: string
  expected: string
  observed: string
  impact: string
  evidenceLabel?: string
}

export type Journey = {
  id: string
  projectId: string
  projectName?: string
  template: "lead_form" | "trial_signup" | "legacy_endpoint"
  name: string
  description: string
  status: EvalStatus
  schedule: string
  owner: string
  environment: "Production" | "Staging"
  lastRunAt: string
  stages: JourneyStage[]
  starred?: boolean
  startUrl?: string
  draftRevision?: number
  published?: boolean
  rawDraft?: JourneyDraftInput
  source?: "business_eval" | "legacy_endpoint"
  stageEvidenceAvailable?: boolean
  pausedAt?: string | null
  pauseReason?: string
  scheduleEnabled?: boolean
  supervisedRunId?: string | null
  cleanupVerified?: boolean
  schedulePausedAt?: string | null
  schedulePauseReason?: string
  archivedAt?: string | null
}

export type EvalStageEvidence = {
  id: string
  definitionId: string
  position: number
  status: EvalStatus
  verdict: EvalStatus
  expected: string
  observed: string
  errorCode: string
  diagnostics: unknown
  assertions: unknown[]
  evidenceArtifactIds: string[]
  startedAt: string
  completedAt: string
  duration: string
}

export type EvalEvidenceArtifact = {
  id: string
  stageRunId: string
  kind: string
  mimeType: string
  byteSize: number
  sha256: string
  redacted: boolean
  expiresAt: string
  createdAt: string
}

export type EvalRun = {
  id: string
  journeyId: string
  journeyName?: string
  startedAt: string
  status: EvalStatus
  duration: string
  degradedStage?: string
  impact: string
  triggeredBy: string
  journeyVersionId?: string
  runnerProvider?: string
  completedAt?: string
  summary?: string
  cleanupStatus?: string
  cleanupErrorSummary?: string
  cancelRequestedAt?: string | null
  stageEvidence?: EvalStageEvidence[]
  evidenceArtifacts?: EvalEvidenceArtifact[]
  source?: "business_eval" | "legacy_endpoint"
  stageEvidenceAvailable?: boolean
  legacyEndpointEvidence?: {
    checkId: string
    checkName: string
    evidenceOrigin: "legacy_browser" | "service"
    statusCode: number | null
    latencyMs: number | null
    assertionResults: unknown[]
    safeResponseSummary: string
    errorMessage: string
  }
}

export type Incident = {
  id: string
  journeyId: string
  journeyName?: string
  title: string
  summary: string
  status: "open" | "in_review" | "snoozed" | "resolved" | "ignored"
  severity: "critical" | "high" | "medium" | "low"
  openedAt: string
  owner: string
  impact: string
  repairNote?: string
  ownerUserId?: string | null
  source?: "business_eval" | "legacy_endpoint"
  resolvedAt?: string | null
  verificationEvalRunId?: string | null
}

export type EvalReport = {
  id: string
  projectId: string
  projectName?: string
  title: string
  period: string
  status: "draft" | "ready" | "shared" | "sent" | "blocked"
  createdAt: string
  passRate: string
  journeysCovered: number
  incidentsResolved: number
  summary: string
  snapshotVersion?: number
  staleAt?: string | null
  pdfReady?: boolean
  rawMetrics?: Record<string, unknown>
  shares?: EvalReportShare[]
  source?: "business_eval" | "legacy_endpoint"
  evidenceModel?: "Business eval" | "Legacy endpoint"
  shareEligible?: boolean
  coverageDisclosure?: string
  reportMetrics?: ReportSafeMetrics
  journeyCoverage?: ReportJourneyCoverage[]
  reportIncidents?: ReportIncidentSummary[]
  verifiedRecoveries?: ReportIncidentSummary[]
  evidenceSummaries?: ReportEvidenceSummary[]
  provenance?: ReportProvenance
  evidenceFingerprint?: string
}

export type EvalReportShare = {
  id: string
  snapshotVersion: number
  expiresAt: string
  revokedAt: string | null
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
}

export type EvalsData = {
  projects: Project[]
  journeys: Journey[]
  runs: EvalRun[]
  incidents: Incident[]
  reports: EvalReport[]
}

export type EvalsCollection = "projects" | "journeys" | "runs" | "incidents" | "reports"

export type EvalsPaginationState = Record<EvalsCollection, {
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => Promise<void>
}>

export type JourneyDraft = JourneyDraftInput

export type InteractiveEvalRunMode = "manual" | "supervised" | "debug"

export type EvalsEndpointHooks = {
  createJourney?: (draft: JourneyDraft) => Promise<Journey>
  updateJourney?: (id: string, draft: JourneyDraft) => Promise<Journey>
  runJourney?: (id: string, mode: InteractiveEvalRunMode) => Promise<EvalRun>
  mutateIncident?: (id: string, mutation: IncidentMutation) => Promise<Incident | EvalRun>
  cancelRun?: (id: string) => Promise<{ id: string; cancelRequestedAt: string }>
  pauseJourney?: (id: string, reason: string) => Promise<Journey>
  resumeJourney?: (id: string) => Promise<Journey>
  configureJourneySchedule?: (id: string, enabled: boolean, intervalMinutes: number) => Promise<Journey>
}
