import { z } from "zod"

const identifierSchema = z.string().min(1)
const nullableTextSchema = z.string().nullable()
const jsonObjectSchema = z.record(z.string(), z.unknown())

export const businessEvalsResponseMetaSchema = z.object({
  nextCursor: z.string().nullable().optional(),
  total: z.number().int().nonnegative().optional(),
}).strict()

export const businessEvalsErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(2_000),
  }).strict(),
}).strict()

export const businessEvalsSuccessEnvelopeBaseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  meta: businessEvalsResponseMetaSchema.optional(),
}).strict()

export function businessEvalsSuccessEnvelopeSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
    meta: businessEvalsResponseMetaSchema.optional(),
  }).strict()
}

export type ParsedBusinessEvalsPayload<T> =
  | { ok: true; data: T; meta?: z.infer<typeof businessEvalsResponseMetaSchema> }
  | z.infer<typeof businessEvalsErrorEnvelopeSchema>

export function parseBusinessEvalsResponsePayload<TSchema extends z.ZodType>(
  payload: unknown,
  dataSchema: TSchema
): ParsedBusinessEvalsPayload<z.infer<TSchema>> | null {
  const errorEnvelope = businessEvalsErrorEnvelopeSchema.safeParse(payload)
  if (errorEnvelope.success) return errorEnvelope.data

  const successEnvelope = businessEvalsSuccessEnvelopeBaseSchema.safeParse(payload)
  if (!successEnvelope.success) return null
  const data = dataSchema.safeParse(successEnvelope.data.data)
  if (!data.success) return null
  return {
    ok: true,
    data: data.data,
    ...(successEnvelope.data.meta ? { meta: successEnvelope.data.meta } : {}),
  }
}

export const businessEvalsAccessResponseSchema = z.object({
  enabled: z.boolean(),
  workspaceId: identifierSchema,
}).strict()

export const projectResponseSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  website: z.string(),
  kind: z.enum(["own_product", "client_site", "personal"]),
  health: z.enum(["healthy", "degraded", "failed", "pending"]),
  activeJourneys: z.number().int().nonnegative(),
  legacyEndpointJourneys: z.number().int().nonnegative(),
  businessEvalJourneys: z.number().int().nonnegative(),
  openIncidents: z.number().int().nonnegative(),
  lastRunAt: nullableTextSchema,
  ownerUserId: nullableTextSchema,
  ownerName: z.string().optional(),
  ownerEmail: z.string().optional(),
  reportStatus: nullableTextSchema,
  archivedAt: nullableTextSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  reportRecipientEmail: z.string().optional(),
  reportCadence: z.string().optional(),
  notes: z.string().optional(),
  authorization: z.object({
    id: identifierSchema,
    domain: z.string().min(1),
    approvedActionDomains: z.array(z.string().min(1)),
    attestationVersion: z.string().min(1),
    actor: z.object({
      userId: identifierSchema,
      name: z.string(),
      email: z.string(),
    }).strict(),
    recordedAt: z.string().min(1),
    revokedAt: nullableTextSchema,
    state: z.enum(["current", "revoked"]),
  }).strict().nullable().optional(),
}).passthrough()

export const projectCollectionResponseSchema = z.array(projectResponseSchema)

export const projectAuthorizationResponseSchema = z.object({
  id: identifierSchema,
  agency_id: identifierSchema,
  client_id: identifierSchema,
  hostname: z.string().min(1),
  attestation_version: z.string().min(1),
  attested_by_user_id: identifierSchema,
  attested_at: z.string().min(1),
  approved_action_domains: z.array(z.string().min(1)),
  revoked_at: nullableTextSchema,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
}).strict()

export const projectAuthorizationDetailResponseSchema = projectResponseSchema.shape.authorization.unwrap()

const journeyTemplateResponseSchema = z.enum(["lead_form", "trial_signup", "legacy_endpoint"])

const journeyVersionResponseSchema = z.object({
  id: identifierSchema,
  version_number: z.number().int().positive(),
  template: journeyTemplateResponseSchema,
  definition_json: jsonObjectSchema,
  created_by_user_id: nullableTextSchema,
  created_at: z.string(),
}).passthrough()

const journeyStageDefinitionResponseSchema = z.object({
  id: identifierSchema,
  stage_key: z.string().min(1),
  name: z.string(),
  position: z.number().int().nonnegative(),
  is_cleanup: z.boolean(),
  action_manifest_json: jsonObjectSchema,
  expected_text: z.string(),
  business_impact: z.string(),
  timing_threshold_ms: z.number().int().positive().nullable(),
}).passthrough()

const journeyScheduleResponseSchema = z.object({
  id: identifierSchema.nullable(),
  enabled: z.boolean(),
  interval_minutes: z.number().int().positive(),
  next_run_at: nullableTextSchema,
  last_run_at: nullableTextSchema,
  supervised_run_id: nullableTextSchema,
  cleanup_verified: z.boolean(),
  paused_at: nullableTextSchema,
  pause_reason: z.string(),
}).passthrough()

const journeyHistoryRunResponseSchema = z.object({
  id: identifierSchema,
  source: z.enum(["business_eval", "legacy_endpoint"]),
}).passthrough()

const journeyIncidentSummaryResponseSchema = z.object({
  id: identifierSchema,
  status: z.string(),
  severity: z.string(),
  title: z.string(),
  eval_run_id: nullableTextSchema,
  eval_stage_run_id: nullableTextSchema,
  owner_user_id: nullableTextSchema,
  updated_at: z.string(),
}).passthrough()

const legacyCheckResponseSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  enabled: z.boolean(),
  pending_setup: z.boolean(),
  schedule_minutes: z.number().int().positive(),
  last_run_at: nullableTextSchema,
  next_run_at: nullableTextSchema,
}).passthrough()

export const journeyResponseSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  projectName: z.string().optional(),
  name: z.string(),
  template: journeyTemplateResponseSchema,
  source: z.enum(["business_eval", "legacy_endpoint"]),
  status: z.string(),
  stageEvidenceAvailable: z.boolean(),
  startUrl: z.string().optional(),
  draft: jsonObjectSchema.optional(),
  draftRevision: z.number().int().nonnegative().optional(),
  publishedVersionId: nullableTextSchema.optional(),
  publishedVersion: journeyVersionResponseSchema.nullable().optional(),
  versions: z.array(journeyVersionResponseSchema).optional(),
  stages: z.array(journeyStageDefinitionResponseSchema).optional(),
  schedule: z.union([z.number(), journeyScheduleResponseSchema, z.null()]).optional(),
  runs: z.array(journeyHistoryRunResponseSchema).optional(),
  incidents: z.array(journeyIncidentSummaryResponseSchema).optional(),
  legacyChecks: z.array(legacyCheckResponseSchema).optional(),
  published: z.boolean().optional(),
  coverage: z.string().optional(),
  nextRunAt: nullableTextSchema.optional(),
  lastRunAt: nullableTextSchema.optional(),
  lastVerdict: nullableTextSchema.optional(),
  pausedAt: nullableTextSchema.optional(),
  pauseReason: z.string().optional(),
  archivedAt: nullableTextSchema.optional(),
  scheduleEnabled: z.boolean().optional(),
  supervisedRunId: nullableTextSchema.optional(),
  cleanupVerified: z.boolean().optional(),
  schedulePausedAt: nullableTextSchema.optional(),
  schedulePauseReason: z.string().optional(),
  legacyCheckCount: z.number().int().nonnegative().optional(),
  activeLegacyCheckCount: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

export const journeyCollectionResponseSchema = z.array(journeyResponseSchema)

export const publishedJourneyResponseSchema = journeyResponseSchema.extend({
  forwardingRecipient: nullableTextSchema,
})

export const forwardingAddressResponseSchema = z.object({
  forwardingRecipient: nullableTextSchema,
}).strict()

const semanticFieldLocatorSchema = z.union([
  z.object({ kind: z.literal("label"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("placeholder"), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("test_id"), value: z.string().min(1) }).strict(),
])

export const journeyScanResponseSchema = z.object({
  url: z.string(),
  title: z.string(),
  captchaDetected: z.boolean(),
  fields: z.array(z.object({
    key: z.string().min(1),
    control: z.enum(["input", "textarea", "select"]),
    inputType: z.string(),
    label: z.string(),
    name: z.string(),
    required: z.boolean(),
    options: z.array(z.object({
      value: z.string(),
      label: z.string(),
      disabled: z.boolean(),
    }).strict()),
    locator: semanticFieldLocatorSchema.nullable(),
  }).strict()),
  actions: z.array(z.object({
    key: z.string().min(1),
    label: z.string(),
    role: z.literal("button"),
    locator: z.object({
      kind: z.literal("role"),
      role: z.literal("button"),
      name: z.string().min(1),
    }).strict(),
  }).strict()),
  warnings: z.array(z.string()),
  template: z.enum(["lead_form", "trial_signup"]),
  projectId: identifierSchema,
  approvedActionDomains: z.array(z.string().min(1)),
}).strict()

const evalStageRunResponseSchema = z.object({
  id: identifierSchema,
  stage_definition_id: identifierSchema,
  position: z.number().int().nonnegative(),
  status: z.string(),
  verdict: z.string(),
  expected_text: z.string(),
  observed_text: z.string(),
  error_code: z.string(),
  diagnostics_json: z.unknown(),
  assertion_results_json: z.array(z.unknown()),
  evidence_artifact_ids: z.array(identifierSchema),
  started_at: nullableTextSchema,
  completed_at: nullableTextSchema,
  duration_ms: z.number().finite().nonnegative().nullable(),
}).passthrough()

const evalEvidenceArtifactResponseSchema = z.object({
  id: identifierSchema,
  eval_stage_run_id: nullableTextSchema,
  artifact_kind: z.string(),
  mime_type: z.string(),
  byte_size: z.number().int().nonnegative(),
  sha256: z.string(),
  redacted: z.boolean(),
  expires_at: z.string(),
  created_at: z.string(),
}).passthrough()

const legacyEndpointEvidenceResponseSchema = z.object({
  checkId: z.string(),
  checkName: z.string(),
  evidenceOrigin: z.enum(["legacy_browser", "service"]),
  statusCode: z.number().finite().nullable(),
  latencyMs: z.number().finite().nonnegative().nullable(),
  assertionResults: z.array(z.unknown()),
  safeResponseSummary: z.string(),
  errorMessage: z.string(),
}).strict()

export const evalRunResponseSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  journeyId: identifierSchema,
  journeyName: z.string().optional(),
  journeyVersionId: nullableTextSchema,
  trigger: z.string(),
  source: z.enum(["business_eval", "legacy_endpoint"]),
  status: z.string(),
  verdict: z.string(),
  runnerProvider: z.string(),
  startedAt: nullableTextSchema,
  completedAt: nullableTextSchema,
  durationMs: z.number().finite().nonnegative().nullable(),
  summary: z.string(),
  businessImpact: z.string(),
  cleanupStatus: z.string(),
  cleanupErrorSummary: z.string(),
  cancelRequestedAt: nullableTextSchema,
  stageEvidenceAvailable: z.boolean(),
  stages: z.array(evalStageRunResponseSchema).optional(),
  evidence: z.array(evalEvidenceArtifactResponseSchema).optional(),
  legacyEndpointEvidence: legacyEndpointEvidenceResponseSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

export const evalRunCollectionResponseSchema = z.array(evalRunResponseSchema)

export const enqueuedEvalRunResponseSchema = z.object({
  id: identifierSchema,
  trigger: z.enum(["manual", "supervised", "verification", "debug"]),
  enqueued: z.boolean(),
  quotaUsed: z.number().int().nonnegative(),
  quotaLimit: z.number().int().nonnegative().nullable(),
  orchestrationRunId: nullableTextSchema,
}).strict()

export const verificationEnqueuedEvalRunResponseSchema = enqueuedEvalRunResponseSchema.extend({
  journeyId: identifierSchema,
})

export const evalRunCancellationResponseSchema = z.object({
  id: identifierSchema,
  cancelRequestedAt: z.string().min(1),
  orchestrationRunId: z.string(),
}).strict()

export const evidenceAccessResponseSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
}).strict()

const aiSyntheticValueKeyResponseSchema = z.enum([
  "marker",
  "first_name",
  "last_name",
  "full_name",
  "name",
  "email",
  "company",
  "workspace",
  "message",
  "password",
  "number",
  "url",
])

const aiSemanticLocatorResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({ kind: z.literal("label"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("placeholder"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("test_id"), value: z.string().trim().min(1).max(200) }).strict(),
])

export const aiJourneyDraftSuggestionResponseSchema = z.object({
  fieldMappings: z.array(z.object({
    fieldKey: z.string().trim().min(1).max(80),
    valueKey: aiSyntheticValueKeyResponseSchema,
    reason: z.string().trim().min(1).max(400),
  }).strict()).max(50),
  locators: z.array(z.object({
    target: z.enum(["field", "submit"]),
    targetKey: z.string().trim().min(1).max(80),
    locator: aiSemanticLocatorResponseSchema,
    reason: z.string().trim().min(1).max(400),
  }).strict()).max(70),
  businessImpacts: z.array(z.object({
    stageKey: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(600),
    reason: z.string().trim().min(1).max(400),
  }).strict()).max(30),
  cautions: z.array(z.string().trim().min(1).max(400)).max(10),
}).strict()

export const aiJourneyDraftResponseSchema = aiJourneyDraftSuggestionResponseSchema.extend({
  requestId: z.string().uuid(),
  status: z.literal("draft"),
  reviewRequired: z.literal(true),
  publishable: z.literal(false),
  model: z.string().trim().min(1).max(120),
  baseDraftRevision: z.number().int().nonnegative().nullable(),
}).strict()

export const aiRunDiagnosisSuggestionResponseSchema = z.object({
  summary: z.string().trim().min(1).max(800),
  likelyCause: z.string().trim().min(1).max(800),
  nextSteps: z.array(z.string().trim().min(1).max(500)).max(8),
  evidenceGaps: z.array(z.string().trim().min(1).max(500)).max(8),
  caution: z.string().trim().min(1).max(600),
}).strict()

export const aiRunDiagnosisResponseSchema = aiRunDiagnosisSuggestionResponseSchema.extend({
  requestId: z.string().uuid(),
  status: z.literal("draft"),
  reviewRequired: z.literal(true),
  model: z.string().trim().min(1).max(120),
  sourceVerdict: z.enum(["failed", "inconclusive"]),
}).strict()

const incidentNoteResponseSchema = z.object({
  id: identifierSchema,
  user_id: nullableTextSchema,
  body: z.string(),
  report_safe: z.boolean(),
  created_at: z.string(),
}).passthrough()

export const incidentResponseSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  journeyId: identifierSchema,
  journeyName: z.string().optional(),
  source: z.enum(["business_eval", "legacy_endpoint"]),
  stageEvidenceAvailable: z.boolean(),
  severity: z.string(),
  status: z.string(),
  title: z.string(),
  description: z.string(),
  suggestedAction: z.string(),
  ownerUserId: nullableTextSchema,
  occurrenceCount: z.number().int().positive(),
  snoozedUntil: nullableTextSchema,
  repairRecordedAt: nullableTextSchema,
  resolvedAt: nullableTextSchema,
  verificationEvalRunId: nullableTextSchema,
  verificationLegacyRunId: nullableTextSchema,
  repairNote: z.string(),
  reportSafeSummary: z.string(),
  evalRunId: nullableTextSchema,
  evalStageRunId: nullableTextSchema,
  legacyCheckRunId: nullableTextSchema,
  legacyCheckId: nullableTextSchema,
  notes: z.array(incidentNoteResponseSchema).optional(),
  journeySource: z.enum(["business_eval", "legacy_endpoint"]).optional(),
  journeyArchivedAt: nullableTextSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

export const incidentCollectionResponseSchema = z.array(incidentResponseSchema)

const reportShareLedgerResponseSchema = z.object({
  id: identifierSchema,
  snapshot_version: z.number().int().positive(),
  expires_at: z.string(),
  revoked_at: nullableTextSchema,
  access_count: z.number().int().nonnegative(),
  last_accessed_at: nullableTextSchema,
  created_at: z.string(),
}).strict()

const reportVerdictResponseSchema = z.enum(["passed", "degraded", "failed", "inconclusive", "cancelled", "not_run"])

const reportMetricsResponseSchema = z.object({
  journeysCovered: z.number().int().nonnegative(),
  evalRuns: z.number().int().nonnegative(),
  passedRuns: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(100),
  incidents: z.number().int().nonnegative(),
  recoveries: z.number().int().nonnegative(),
}).strict()

const reportJourneyCoverageResponseSchema = z.object({
  journeyId: identifierSchema,
  name: z.string(),
  template: z.enum(["lead_form", "trial_signup", "legacy_endpoint"]),
  runCount: z.number().int().nonnegative(),
  latestVerdict: reportVerdictResponseSchema,
  latestCompletedAt: nullableTextSchema,
}).strict()

const reportIncidentSummaryResponseSchema = z.object({
  incidentId: identifierSchema,
  journeyId: identifierSchema,
  sourceEvalRunId: nullableTextSchema,
  verificationEvalRunId: nullableTextSchema,
  severity: z.enum(["critical", "high", "medium", "low"]),
  status: z.enum(["open", "in_review", "snoozed", "resolved", "ignored"]),
  title: z.string(),
  reportSafeSummary: z.string(),
  createdAt: z.string(),
  resolvedAt: nullableTextSchema,
}).strict()

const reportRecoverySummaryResponseSchema = reportIncidentSummaryResponseSchema.extend({
  verificationEvalRunId: identifierSchema,
  status: z.literal("resolved"),
  resolvedAt: z.string().min(1),
}).strict()

const reportSafeArtifactResponseSchema = z.object({
  artifactId: identifierSchema,
  kind: z.literal("screenshot"),
  mimeType: z.enum(["image/png", "image/jpeg"]),
}).strict()

const reportStageEvidenceSummaryResponseSchema = z.object({
  position: z.number().int().nonnegative(),
  verdict: reportVerdictResponseSchema,
  expected: z.string(),
  errorCode: nullableTextSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  artifacts: z.array(reportSafeArtifactResponseSchema),
}).strict()

const reportEvidenceSummaryResponseSchema = z.object({
  runId: identifierSchema,
  journeyId: identifierSchema,
  verdict: reportVerdictResponseSchema,
  summary: z.string(),
  businessImpact: z.string(),
  cleanupStatus: z.enum(["pending", "passed", "failed", "not_required", "skipped"]),
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  stages: z.array(reportStageEvidenceSummaryResponseSchema),
}).strict()

const reportProvenanceResponseSchema = z.object({
  source: z.enum(["business_eval", "legacy_endpoint"]),
  schemaVersion: z.number().int().nonnegative(),
  snapshotVersion: z.number().int().nonnegative(),
  generatedAt: z.string(),
  evidenceFingerprint: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
}).strict()

const reportSafeContentResponseShape = {
  summary: z.string(),
  metrics: reportMetricsResponseSchema,
  coverage: z.object({
    journeys: z.array(reportJourneyCoverageResponseSchema),
    journeysCovered: z.number().int().nonnegative(),
    source: z.enum(["business_eval", "legacy_endpoint"]),
  }).strict(),
  incidents: z.array(reportIncidentSummaryResponseSchema),
  recoveries: z.array(reportRecoverySummaryResponseSchema),
  evidenceSummaries: z.array(reportEvidenceSummaryResponseSchema),
  provenance: reportProvenanceResponseSchema,
  evidenceFingerprint: z.union([z.literal(""), z.string().regex(/^[a-f0-9]{64}$/)]),
}

export const reportResponseSchema = z.object({
  id: identifierSchema,
  projectId: identifierSchema,
  projectName: z.string().optional(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  snapshotVersion: z.number().int().nonnegative(),
  source: z.enum(["business_eval", "legacy_endpoint"]),
  evidenceModel: z.enum(["Business eval", "Legacy endpoint"]),
  stageEvidenceAvailable: z.boolean(),
  shareEligible: z.boolean(),
  hasActiveShare: z.boolean(),
  coverageDisclosure: z.string(),
  ...reportSafeContentResponseShape,
  staleAt: nullableTextSchema,
  pdfReady: z.boolean(),
  shares: z.array(reportShareLedgerResponseSchema).optional(),
  projectArchivedAt: nullableTextSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict().superRefine(validateReportSafeRelationships)

export const reportCollectionResponseSchema = z.array(reportResponseSchema)

export const sharedReportResponseSchema = z.object({
  id: identifierSchema,
  projectName: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  snapshotVersion: z.number().int().positive(),
  expiresAt: z.string(),
  brandName: z.string(),
  source: z.literal("business_eval"),
  evidenceModel: z.literal("Business eval"),
  stageEvidenceAvailable: z.literal(true),
  coverageDisclosure: z.string(),
  ...reportSafeContentResponseShape,
}).strict().superRefine(validateReportSafeRelationships)

function validateReportSafeRelationships(value: {
  source: "business_eval" | "legacy_endpoint"
  snapshotVersion: number
  evidenceFingerprint: string
  metrics: { journeysCovered: number; recoveries: number }
  coverage: { source: "business_eval" | "legacy_endpoint"; journeysCovered: number }
  recoveries: unknown[]
  provenance: { source: "business_eval" | "legacy_endpoint"; snapshotVersion: number; evidenceFingerprint: string }
}, context: z.RefinementCtx) {
  const invalid = (path: Array<string | number>, message: string) => context.addIssue({ code: "custom", path, message })
  if (value.coverage.source !== value.source) invalid(["coverage", "source"], "Coverage source must match the report source.")
  if (value.provenance.source !== value.source) invalid(["provenance", "source"], "Provenance source must match the report source.")
  if (value.provenance.snapshotVersion !== value.snapshotVersion) invalid(["provenance", "snapshotVersion"], "Provenance must match the immutable snapshot version.")
  if (value.provenance.evidenceFingerprint !== value.evidenceFingerprint) invalid(["provenance", "evidenceFingerprint"], "Provenance must match the report evidence fingerprint.")
  if (value.metrics.journeysCovered !== value.coverage.journeysCovered) invalid(["coverage", "journeysCovered"], "Coverage count must match the report metrics.")
  if (value.metrics.recoveries !== value.recoveries.length) invalid(["recoveries"], "Recovery count must match the verified recovery evidence.")
  if (value.source === "business_eval" && !/^[a-f0-9]{64}$/.test(value.evidenceFingerprint)) invalid(["evidenceFingerprint"], "Business eval reports require a service evidence fingerprint.")
}

export const reportShareLinkResponseSchema = z.object({
  id: identifierSchema,
  url: z.string().url(),
  expiresAt: z.string().min(1),
  snapshotVersion: z.number().int().positive(),
}).strict()

export const revokedReportShareLinkResponseSchema = z.object({
  id: identifierSchema,
  revokedAt: z.string().min(1),
}).strict()

export const workspaceSettingsResponseSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string(),
  primaryColor: z.string().nullable(),
  reportSenderName: z.string(),
  reportSenderEmail: z.string(),
  plan: z.string(),
  updatedAt: z.string().min(1),
}).strict()

const workspaceRoleResponseSchema = z.enum(["owner", "admin", "member"])

export const teamSettingsResponseSchema = z.object({
  members: z.array(z.object({
    id: identifierSchema,
    userId: identifierSchema,
    role: workspaceRoleResponseSchema,
    name: z.string(),
    email: z.string(),
    avatarUrl: z.string(),
    joinedAt: z.string(),
  }).strict()),
  usage: z.object({
    seatsUsed: z.number().int().nonnegative(),
    seatLimit: z.number().int().nonnegative().nullable(),
    plan: z.string(),
  }).strict(),
}).strict()

export const teamInvitationResponseSchema = z.object({
  membershipId: identifierSchema,
  userId: identifierSchema,
  email: z.string(),
  role: workspaceRoleResponseSchema,
  invitationEmailSent: z.boolean(),
}).strict()

export const teamMemberUpdateResponseSchema = z.object({
  userId: identifierSchema,
  role: z.enum(["admin", "member"]),
}).strict()

export const teamMemberRemovalResponseSchema = z.object({
  removed: z.literal(true),
  userId: identifierSchema,
}).strict()

export const alertEndpointResponseSchema = z.object({
  id: identifierSchema,
  name: z.string(),
  kind: z.enum(["email", "webhook"]),
  destinationPreview: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

export const alertSettingsResponseSchema = z.object({
  endpoints: z.array(alertEndpointResponseSchema),
  deliveries: z.array(z.object({
    id: identifierSchema,
    endpointId: identifierSchema,
    evalRunId: nullableTextSchema,
    incidentId: nullableTextSchema,
    eventType: z.string(),
    status: z.string(),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: nullableTextSchema,
    deliveredAt: nullableTextSchema,
    lastError: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).strict()),
  entitlement: z.object({
    email: z.boolean(),
    webhook: z.boolean(),
    state: z.string(),
    plan: z.string(),
  }).strict(),
}).strict()

export const alertEndpointMutationResponseSchema = z.object({
  endpoint: alertEndpointResponseSchema,
  signingSecret: nullableTextSchema,
}).strict()

export const alertEndpointDeletionResponseSchema = z.object({
  deleted: z.boolean(),
  disabled: z.boolean(),
  reason: z.string().optional(),
}).strict()

const usageLimitResponseSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
}).strict()

export const billingSettingsResponseSchema = z.object({
  plan: z.object({
    id: z.string(),
    publicKey: z.string(),
    name: z.string(),
    state: z.string(),
    grandfathered: z.boolean(),
    annualDiscountPercent: z.number().nonnegative(),
  }).strict(),
  usage: z.object({
    projects: usageLimitResponseSchema,
    journeys: usageLimitResponseSchema,
    runs: usageLimitResponseSchema,
    seats: usageLimitResponseSchema,
    evidenceRetentionDays: z.number().int().nonnegative(),
  }).strict(),
  features: z.record(z.string(), z.boolean()),
  trial: z.object({
    startedAt: nullableTextSchema,
    endsAt: nullableTextSchema,
    usedAt: nullableTextSchema,
    active: z.boolean(),
  }).strict(),
  subscription: z.object({
    status: z.string(),
    portalAvailable: z.boolean(),
    portalUnavailableReason: nullableTextSchema,
  }).strict(),
}).strict()

export type WorkspaceSettingsResponse = z.infer<typeof workspaceSettingsResponseSchema>
export type TeamSettingsResponse = z.infer<typeof teamSettingsResponseSchema>
export type AlertSettingsResponse = z.infer<typeof alertSettingsResponseSchema>
export type BillingSettingsResponse = z.infer<typeof billingSettingsResponseSchema>
