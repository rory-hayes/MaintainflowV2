export type AgencyRole = "owner" | "admin" | "member"

export type WorkflowMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type WorkflowStatus = "pending" | "healthy" | "degraded" | "failed" | "archived"

export type CheckStatus = "healthy" | "degraded" | "failed" | "skipped"

export type CheckRunEvidenceOrigin = "legacy_browser" | "service"

export type IssueSeverity = "low" | "medium" | "high" | "critical"

export type IssueStatus = "open" | "in_review" | "snoozed" | "resolved" | "ignored"

export type ReportStatus = "draft" | "ready" | "sent" | "blocked"

export type CheckJobStatus = "success" | "partial" | "failed" | "skipped"

export type StripeSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"

export type AssertionType =
  | "response_exists"
  | "json_field_exists"
  | "json_field_equals"
  | "text_contains"
  | "text_not_contains"
  | "regex_match"

export type AssertionConfig = {
  id: string
  type: AssertionType
  path?: string
  expected?: string
  pattern?: string
  enabled: boolean
}

export type AssertionResult = {
  id: string
  label: string
  passed: boolean
  actual?: string
  expected?: string
  reason?: string
}

export type Agency = {
  id: string
  name: string
  slug: string
  plan: "free" | "starter" | "growth" | "scale" | "agency_plus"
  trialEndsAt: string | null
  stripeCustomerId: string
  stripeSubscriptionId: string
  stripeSubscriptionStatus?: StripeSubscriptionStatus | ""
  complimentaryEntitlement?: boolean
  complimentaryEntitlementReason?: string
  reportSenderName: string
  reportSenderEmail: string
  createdAt: string
  updatedAt: string
}

export type Membership = {
  id: string
  agencyId: string
  userId: string
  role: AgencyRole
  createdAt: string
}

export type Client = {
  id: string
  agencyId: string
  name: string
  slug: string
  website: string
  ownerUserId: string
  reportRecipientEmail: string
  reportCadence: "monthly" | "quarterly"
  notes: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Workflow = {
  id: string
  agencyId: string
  clientId: string
  name: string
  type: "http_endpoint" | "webhook" | "n8n" | "make" | "zapier" | "mcp_server" | "custom_api" | "manual_log"
  environment: "production" | "staging" | "development"
  endpointUrl: string
  method: WorkflowMethod
  headers: Array<{ key: string; valuePreview: string; sensitive: boolean }>
  requestBody: string
  expectedStatus: number
  timeoutSeconds: number
  maxLatencyMs: number
  frequencyMinutes: number
  retries: number
  reportIncluded: boolean
  storeRawResponse: boolean
  status: WorkflowStatus
  healthScore: number
  lastCheckRunAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Check = {
  id: string
  agencyId: string
  workflowId: string
  name: string
  type: "health" | "synthetic" | "manual_log"
  pluginId: string
  configJson: Record<string, unknown>
  enabled: boolean
  pendingSetup: boolean
  scheduleMinutes: number
  assertions: AssertionConfig[]
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}

export type CheckRun = {
  id: string
  agencyId: string
  clientId: string
  workflowId: string
  checkId: string
  evidenceOrigin: CheckRunEvidenceOrigin
  status: CheckStatus
  statusCode: number | null
  latencyMs: number | null
  assertionResults: AssertionResult[]
  resultJson: Record<string, unknown>
  safeResponseSummary: string
  errorMessage: string
  startedAt: string
  completedAt: string
  createdAt: string
}

export type CheckJobRun = {
  id: string
  agencyId: string
  status: CheckJobStatus
  checksDue: number
  checksRun: number
  failures: number
  errorMessage: string
  startedAt: string
  completedAt: string
  createdAt: string
}

export type Issue = {
  id: string
  agencyId: string
  clientId: string
  workflowId: string
  checkRunId: string
  verificationRunId: string | null
  checkId: string
  dedupeKey: string
  severity: IssueSeverity
  status: IssueStatus
  title: string
  description: string
  suggestedAction: string
  ownerUserId: string
  reportable: boolean
  occurrenceCount: number
  snoozedUntil: string | null
  repairRecordedAt: string | null
  resolvedAt: string | null
  resolutionNote: string
  reportSafeSummary: string
  createdAt: string
  updatedAt: string
}

export type IssueNote = {
  id: string
  agencyId: string
  issueId: string
  userId: string
  body: string
  reportSafe: boolean
  createdAt: string
}

export type Report = {
  id: string
  agencyId: string
  clientId: string
  periodStart: string
  periodEnd: string
  status: ReportStatus
  narrative: string
  readiness: Record<string, boolean>
  metrics: ReportMetrics
  snapshotVersion: number
  snapshot: ReportSnapshot | null
  evidenceFingerprint: string
  staleAt: string | null
  pdfDataUrl: string | null
  pdfStoragePath: string | null
  pdfSnapshotVersion: number | null
  sentAt: string | null
  createdAt: string
  updatedAt: string
}

export type ReportItem = {
  id: string
  agencyId: string
  reportId: string
  clientId: string
  sourceType: "workflow" | "check_run" | "issue" | "recommendation"
  sourceId: string
  title: string
  body: string
  reportSafe: boolean
  snapshotVersion: number
  createdAt: string
}

export type ReportMetrics = {
  workflowsMonitored: number
  checksRun: number
  passRate: number
  issuesDetected: number
  issuesResolved: number
  unresolvedHighRiskIssues: number
  averageLatencyMs: number | null
}

export type ReportSnapshot = {
  schemaVersion: 2
  version: number
  generatedAt: string
  periodStart: string
  periodEnd: string
  evidenceFingerprint: string
  presentation: ReportSnapshotPresentation
  workflowIds: string[]
  checkIds: string[]
  checkRunIds: string[]
  issueIds: string[]
  resolutionNoteIds: string[]
  metrics: ReportMetrics
  narrative: string
  workflowCoverage: ReportSnapshotWorkflow[]
  checkRuns: ReportSnapshotCheckRun[]
  issues: ReportSnapshotIssue[]
  recommendations: string[]
  evidenceItems: ReportSnapshotEvidenceItem[]
}

export type ReportSnapshotPresentation = {
  agency: {
    name: string
    reportSenderName: string
    reportSenderEmail: string
  }
  client: {
    name: string
    website: string
    reportRecipientEmail: string
  }
}

export type ReportSnapshotWorkflow = {
  workflowId: string
  name: string
  endpointUrl: string
  method: string
  status: WorkflowStatus | "inconclusive"
  healthScore: number
  checksRun: number
  lastCheckRunAt: string | null
}

export type ReportSnapshotCheckRun = {
  checkRunId: string
  workflowId: string
  checkId: string
  evidenceOrigin: "service"
  workflowName: string
  status: CheckStatus
  statusCode: number | null
  latencyMs: number | null
  summary: string
  createdAt: string
}

export type ReportSnapshotIssue = {
  issueId: string
  workflowId: string
  checkId: string
  workflowName: string
  sourceCheckRunId: string
  sourceEvidenceOrigin: "service"
  verificationRunId: string | null
  verificationEvidenceOrigin: "service" | null
  title: string
  severity: IssueSeverity
  status: IssueStatus
  reportSafeSummary: string
  createdAt: string
  resolvedAt: string | null
  acceptedException: boolean
  recoveryVerified: boolean
  resolutionNoteIds: string[]
}

export type ReportSnapshotEvidenceItem = {
  id: string
  sourceType: ReportItem["sourceType"]
  sourceId: string
  title: string
  body: string
  reportSafe: true
  createdAt: string
}

export type AuditEvent = {
  id: string
  agencyId: string
  actorUserId: string
  entityType: string
  entityId: string
  action: string
  metadata: Record<string, string | number | boolean>
  createdAt: string
}

export type CoreDatabase = {
  agencies: Agency[]
  memberships: Membership[]
  clients: Client[]
  workflows: Workflow[]
  checks: Check[]
  checkRuns: CheckRun[]
  checkJobRuns: CheckJobRun[]
  issues: Issue[]
  issueNotes: IssueNote[]
  reports: Report[]
  reportItems: ReportItem[]
  auditEvents: AuditEvent[]
}

export type ActivationChecklist = {
  agencyCreated: boolean
  clientCreated: boolean
  workflowConnected: boolean
  firstCheckRun: boolean
  issueCreated: boolean
  issueResolved: boolean
  reportGenerated: boolean
}

export type EndpointTestInput = {
  rateLimitKey?: string
  url: string
  method: WorkflowMethod
  headers: Record<string, string>
  body: string
  expectedStatus: number
  timeoutSeconds: number
  maxLatencyMs: number
  assertions: AssertionConfig[]
}

export type EndpointTestResult = {
  status: CheckStatus
  statusCode: number | null
  latencyMs: number | null
  assertionResults: AssertionResult[]
  safeResponseSummary: string
  errorMessage: string
}
