import {
  createReportDownloadData,
  reportGenerationEvidenceError,
} from "./reporting.ts"
import { currentMonthToDate, dateInputValue, validateReportPeriod } from "./report-period.ts"
import {
  buildReportSnapshot,
  evaluateReportReadiness,
  reconcileReportStaleness,
  reportSnapshotIsCurrent,
  reportStatusFromReadiness,
} from "./report-state.ts"
import {
  canVerifyRepair,
  failureInvalidatesIssueResolution,
  invalidatedIssueResolution,
  issueDedupeKey,
  nextIssueOccurrence,
  recordRepairTransition,
  verifiedResolutionTransition,
} from "./issue-lifecycle.ts"
import { sanitizeAssertionResults } from "./assertions.ts"
import {
  assertSavedMonitorPolicy,
  assertSafeSavedAssertions,
  sanitizeSavedAssertions,
  sanitizeSavedCheckConfig,
  savedAssertionsViolation,
  savedCheckConfigForExecution,
  savedMonitorPolicyViolation,
} from "./saved-monitor-policy.ts"
import {
  normalizeCheckRunEvidenceOrigin,
  isServiceIssuedCheckRun,
  serviceIssuedAssuranceView,
  SERVICE_ISSUED_EVIDENCE_ORIGIN,
  workflowAssuranceFromServiceRuns,
} from "./evidence-provenance.ts"
import { sanitizeStoredWorkflowHeaders, storedWorkflowHeaders } from "./workflow-auth.ts"
import { getBillingPlan } from "../billing/plans.ts"
import { getEffectiveBillingPlan } from "../billing/entitlements.ts"
import type {
  ActivationChecklist,
  Agency,
  AuditEvent,
  Check,
  CheckJobRun,
  CheckRun,
  Client,
  CoreDatabase,
  EndpointTestResult,
  Issue,
  IssueNote,
  Membership,
  Report,
  Workflow,
  WorkflowMethod,
  AssertionConfig,
} from "./types.ts"

export const CORE_DB_KEY = "maintain-flow-core-db"

type UserLike = {
  id: string
  name: string
  email: string
  company: string
  role: string
}

export type WorkflowSetupInput = {
  clientId: string
  name: string
  endpointUrl: string
  method: WorkflowMethod
  headers: Record<string, string>
  requestBody: string
  expectedStatus: number
  timeoutSeconds: number
  maxLatencyMs: number
  frequencyMinutes: number
  retries: number
  reportIncluded: boolean
  storeRawResponse: boolean
  environment: Workflow["environment"]
  type: Workflow["type"]
  assertions: AssertionConfig[]
}

export function emptyCoreDatabase(): CoreDatabase {
  return {
    agencies: [],
    memberships: [],
    clients: [],
    workflows: [],
    checks: [],
    checkRuns: [],
    checkJobRuns: [],
    issues: [],
    issueNotes: [],
    reports: [],
    reportItems: [],
    auditEvents: [],
  }
}

export function readCoreDatabase(): CoreDatabase {
  if (typeof window === "undefined") {
    return emptyCoreDatabase()
  }

  try {
    const raw = window.localStorage.getItem(CORE_DB_KEY)
    if (!raw) return emptyCoreDatabase()
    const parsed = { ...emptyCoreDatabase(), ...JSON.parse(raw) } as CoreDatabase
    const safeDatabase = persistenceSafeCoreDatabase(parsed)
    window.localStorage.setItem(CORE_DB_KEY, JSON.stringify(safeDatabase))
    return serviceIssuedAssuranceView(safeDatabase)
  } catch {
    return emptyCoreDatabase()
  }
}

export function writeCoreDatabase(database: CoreDatabase) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CORE_DB_KEY, JSON.stringify(persistenceSafeCoreDatabase(database)))
  }
}

function persistenceSafeCoreDatabase(database: CoreDatabase): CoreDatabase {
  const unsafeWorkflowIds = new Set<string>()
  const workflows = database.workflows.map((workflow) => {
    const headers = sanitizeStoredWorkflowHeaders(workflow.headers)
    const originalHeadersWereUnsafe = JSON.stringify(workflow.headers ?? []) !== JSON.stringify(headers)
    const headerRecord = Object.fromEntries(headers.map((header) => [header.key, header.valuePreview]))
    const violation = savedMonitorPolicyViolation({
      endpointUrl: workflow.endpointUrl,
      method: workflow.method,
      headers: headerRecord,
      requestBody: workflow.requestBody,
    }, { allowEmptyEndpoint: true })

    if (violation || originalHeadersWereUnsafe || workflow.storeRawResponse) {
      unsafeWorkflowIds.add(workflow.id)
      return {
        ...workflow,
        endpointUrl: "",
        method: "GET" as const,
        headers: [],
        requestBody: "",
        storeRawResponse: false,
        reportIncluded: false,
        status: "pending" as const,
      }
    }

    return {
      ...workflow,
      endpointUrl: workflow.endpointUrl.trim(),
      method: "GET" as const,
      headers,
      requestBody: "",
      storeRawResponse: false,
    }
  })
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]))

  return {
    ...database,
    workflows,
    checks: database.checks.map((check) => {
      const workflow = workflowById.get(check.workflowId)
      let configWasUnsafe = false
      try {
        if (!workflow) throw new Error("Saved workflow is missing.")
        savedCheckConfigForExecution(check.configJson, {
          endpointUrl: workflow.endpointUrl,
          method: workflow.method,
        })
      } catch {
        configWasUnsafe = true
      }
      const mustDisable = configWasUnsafe
        || Boolean(savedAssertionsViolation(check.assertions))
        || unsafeWorkflowIds.has(check.workflowId)
        || !workflow?.endpointUrl
      return {
        ...check,
        configJson: sanitizeSavedCheckConfig(check.configJson),
        assertions: sanitizeSavedAssertions(check.assertions),
        enabled: mustDisable ? false : check.enabled,
        pendingSetup: mustDisable ? true : check.pendingSetup,
        nextRunAt: mustDisable ? null : check.nextRunAt,
      }
    }),
    checkRuns: database.checkRuns.map((run) => ({
      ...run,
      evidenceOrigin: normalizeCheckRunEvidenceOrigin(run.evidenceOrigin),
      assertionResults: sanitizeAssertionResults(run.assertionResults),
      resultJson: {},
    })),
  }
}

export function getUserAgency(database: CoreDatabase, userId: string) {
  const membership = database.memberships.find((item) => item.userId === userId)
  if (!membership) {
    return null
  }

  return database.agencies.find((agency) => agency.id === membership.agencyId) ?? null
}

export function createAgencyWorkspace(database: CoreDatabase, user: UserLike, input: { name: string; slug: string }) {
  const now = timestamp()
  const slug = slugify(input.slug || input.name)
  const agency: Agency = {
    id: id("ag"),
    name: input.name.trim(),
    slug,
    plan: "free",
    trialEndsAt: null,
    stripeCustomerId: "",
    stripeSubscriptionId: "",
    reportSenderName: user.name,
    reportSenderEmail: user.email,
    createdAt: now,
    updatedAt: now,
  }
  const membership: Membership = {
    id: id("mem"),
    agencyId: agency.id,
    userId: user.id,
    role: "owner",
    createdAt: now,
  }

  return withAudit(
    {
      ...database,
      agencies: [agency, ...database.agencies],
      memberships: [membership, ...database.memberships.filter((item) => item.userId !== user.id)],
    },
    agency.id,
    user.id,
    "agency",
    agency.id,
    "created"
  )
}

export function updateAgency(database: CoreDatabase, agencyId: string, input: Partial<Agency>, userId: string) {
  const now = timestamp()
  return reconcileReportStaleness(withAudit(
    {
      ...database,
      agencies: database.agencies.map((agency) =>
        agency.id === agencyId
          ? {
              ...agency,
              ...input,
              slug: input.slug ? slugify(input.slug) : agency.slug,
              updatedAt: now,
            }
          : agency
      ),
    },
    agencyId,
    userId,
    "agency",
    agencyId,
    "updated"
  ), now)
}

export function createClientRecord(database: CoreDatabase, agencyId: string, userId: string, input: Partial<Client> & { name: string }) {
  assertClientLimit(database, agencyId)
  const now = timestamp()
  const client: Client = {
    id: id("cl"),
    agencyId,
    name: input.name.trim(),
    slug: slugify(input.slug || input.name),
    website: input.website ?? "",
    ownerUserId: input.ownerUserId ?? userId,
    reportRecipientEmail: input.reportRecipientEmail ?? "",
    reportCadence: input.reportCadence ?? "monthly",
    notes: input.notes ?? "",
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }

  return withAudit(
    { ...database, clients: [client, ...database.clients] },
    agencyId,
    userId,
    "client",
    client.id,
    "created"
  )
}

export function updateClientRecord(database: CoreDatabase, agencyId: string, userId: string, clientId: string, input: Partial<Client>) {
  const now = timestamp()
  return reconcileReportStaleness(withAudit(
    {
      ...database,
      clients: database.clients.map((client) =>
        client.agencyId === agencyId && client.id === clientId
          ? { ...client, ...input, slug: input.slug ? slugify(input.slug) : client.slug, updatedAt: now }
          : client
      ),
    },
    agencyId,
    userId,
    "client",
    clientId,
    "updated"
  ), now)
}

export function archiveClientRecord(database: CoreDatabase, agencyId: string, userId: string, clientId: string) {
  return updateClientRecord(database, agencyId, userId, clientId, { archivedAt: timestamp() })
}

export function createWorkflowWithFirstRun(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  input: WorkflowSetupInput,
  testResult: EndpointTestResult
) {
  assertWorkflowLimit(database, agencyId, input.clientId)
  const persistedInput = savedWorkflowSetupInput(input)
  const now = timestamp()
  const workflow: Workflow = {
    id: id("wf"),
    agencyId,
    clientId: input.clientId,
    name: input.name.trim(),
    type: input.type,
    environment: input.environment,
    endpointUrl: persistedInput.endpointUrl,
    method: persistedInput.method,
    headers: storedWorkflowHeaders(persistedInput.headers),
    requestBody: persistedInput.requestBody,
    expectedStatus: input.expectedStatus,
    timeoutSeconds: input.timeoutSeconds,
    maxLatencyMs: input.maxLatencyMs,
    frequencyMinutes: input.frequencyMinutes,
    retries: input.retries,
    reportIncluded: input.reportIncluded,
    storeRawResponse: persistedInput.storeRawResponse,
    status: workflowStatus(testResult.status),
    healthScore: healthScore(testResult.status),
    lastCheckRunAt: now,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const check: Check = {
    id: id("chk"),
    agencyId,
    workflowId: workflow.id,
    name: "Default health check",
    type: "health",
    pluginId: "endpoint",
    configJson: endpointPluginConfig(persistedInput),
    enabled: true,
    pendingSetup: false,
    scheduleMinutes: input.frequencyMinutes,
    assertions: persistedInput.assertions,
    lastRunAt: now,
    nextRunAt: addMinutes(now, input.frequencyMinutes),
    createdAt: now,
    updatedAt: now,
  }
  const run = createCheckRunRecord(agencyId, input.clientId, workflow.id, check.id, testResult, now)
  const nextDatabase = {
    ...database,
    workflows: [workflow, ...database.workflows],
    checks: [check, ...database.checks],
    checkRuns: [run, ...database.checkRuns],
  }

  return reconcileReportStaleness(
    withIssueForRun(
      withAudit(nextDatabase, agencyId, userId, "workflow", workflow.id, "created_with_first_check"),
      agencyId,
      userId,
      workflow,
      check,
      run
    ),
    now
  )
}

export function createWorkflowReadyForFirstRun(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  input: WorkflowSetupInput
) {
  assertWorkflowLimit(database, agencyId, input.clientId)
  const persistedInput = savedWorkflowSetupInput(input)
  const now = timestamp()
  const workflow: Workflow = {
    id: id("wf"),
    agencyId,
    clientId: input.clientId,
    name: input.name.trim(),
    type: input.type,
    environment: input.environment,
    endpointUrl: persistedInput.endpointUrl,
    method: persistedInput.method,
    headers: storedWorkflowHeaders(persistedInput.headers),
    requestBody: persistedInput.requestBody,
    expectedStatus: input.expectedStatus,
    timeoutSeconds: input.timeoutSeconds,
    maxLatencyMs: input.maxLatencyMs,
    frequencyMinutes: input.frequencyMinutes,
    retries: input.retries,
    reportIncluded: input.reportIncluded,
    storeRawResponse: persistedInput.storeRawResponse,
    status: "pending",
    healthScore: 0,
    lastCheckRunAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const check: Check = {
    id: id("chk"),
    agencyId,
    workflowId: workflow.id,
    name: "Default health check",
    type: "health",
    pluginId: "endpoint",
    configJson: endpointPluginConfig(persistedInput),
    enabled: true,
    pendingSetup: false,
    scheduleMinutes: input.frequencyMinutes,
    assertions: persistedInput.assertions,
    lastRunAt: null,
    // If the immediate server-issued first run is interrupted after these rows
    // persist, the scheduler gets a bounded recovery attempt instead of leaving
    // an enabled check stranded forever.
    nextRunAt: addMinutes(now, 5),
    createdAt: now,
    updatedAt: now,
  }

  return withAudit(
    {
      ...database,
      workflows: [workflow, ...database.workflows],
      checks: [check, ...database.checks],
    },
    agencyId,
    userId,
    "workflow",
    workflow.id,
    "created_awaiting_server_check"
  )
}

export function createPendingWorkflow(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  input: WorkflowSetupInput & { pendingReason: string }
) {
  assertWorkflowLimit(database, agencyId, input.clientId)
  const persistedInput = savedWorkflowSetupInput(input, true)
  const now = timestamp()
  const workflow: Workflow = {
    id: id("wf"),
    agencyId,
    clientId: input.clientId,
    name: input.name.trim(),
    type: input.type,
    environment: input.environment,
    endpointUrl: persistedInput.endpointUrl,
    method: persistedInput.method,
    headers: storedWorkflowHeaders(persistedInput.headers),
    requestBody: persistedInput.requestBody,
    expectedStatus: input.expectedStatus,
    timeoutSeconds: input.timeoutSeconds,
    maxLatencyMs: input.maxLatencyMs,
    frequencyMinutes: input.frequencyMinutes,
    retries: input.retries,
    reportIncluded: input.reportIncluded,
    storeRawResponse: persistedInput.storeRawResponse,
    status: "pending",
    healthScore: 0,
    lastCheckRunAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const check: Check = {
    id: id("chk"),
    agencyId,
    workflowId: workflow.id,
    name: "Default health check",
    type: "health",
    pluginId: "endpoint",
    configJson: endpointPluginConfig(persistedInput),
    enabled: false,
    pendingSetup: true,
    scheduleMinutes: input.frequencyMinutes,
    assertions: persistedInput.assertions,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
  }

  return withAudit(
    {
      ...database,
      workflows: [workflow, ...database.workflows],
      checks: [check, ...database.checks],
    },
    agencyId,
    userId,
    "workflow",
    workflow.id,
    "created_pending_setup"
  )
}

export function runWorkflowCheck(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  workflowId: string,
  checkId: string,
  testResult: EndpointTestResult,
  auditAction = "manual_run",
  startedAt?: string
) {
  const workflow = database.workflows.find((item) => item.agencyId === agencyId && item.id === workflowId)
  const check = database.checks.find((item) =>
    item.agencyId === agencyId
    && item.workflowId === workflowId
    && item.id === checkId
    && item.enabled
    && !item.pendingSetup
  )

  if (!workflow || !check) {
    throw new Error("Workflow or exact enabled check was not found for this agency.")
  }

  const completedAt = timestamp()
  const run = createCheckRunRecord(
    agencyId,
    workflow.clientId,
    workflow.id,
    check.id,
    testResult,
    startedAt ?? completedAt,
    completedAt
  )
  const checkRuns = [run, ...database.checkRuns]
  const assurance = workflowAssuranceFromServiceRuns(
    database.checks.filter((item) =>
      item.agencyId === agencyId
      && item.workflowId === workflow.id
      && item.enabled
      && !item.pendingSetup
    ),
    checkRuns
  )
  const nextDatabase: CoreDatabase = {
    ...database,
    workflows: database.workflows.map((item) =>
      item.id === workflow.id
        ? {
            ...item,
            status: assurance.status,
            healthScore: assurance.healthScore,
            lastCheckRunAt: assurance.lastRunAt,
            updatedAt: completedAt,
          }
        : item
    ),
    checks: database.checks.map((item) =>
      item.id === check.id
        ? {
            ...item,
            lastRunAt: completedAt,
            nextRunAt: addMinutes(completedAt, item.scheduleMinutes),
            updatedAt: completedAt,
          }
        : item
    ),
    checkRuns,
  }

  return reconcileReportStaleness(
    withIssueForRun(
      withAudit(nextDatabase, agencyId, userId, "check", check.id, auditAction),
      agencyId,
      userId,
      workflow,
      check,
      run
    ),
    completedAt
  )
}

export type DueCheck = {
  check: Check
  workflow: Workflow
}

export type ScheduledCheckAttempt = {
  checkId: string
  workflowId: string
  result?: EndpointTestResult
  errorMessage?: string
}

export function selectDueChecks(database: CoreDatabase, agencyId: string, now = timestamp()): DueCheck[] {
  const currentTime = new Date(now).getTime()
  return database.checks
    .filter((check) => {
      if (check.agencyId !== agencyId || !check.enabled || check.pendingSetup || !check.nextRunAt) {
        return false
      }
      return new Date(check.nextRunAt).getTime() <= currentTime
    })
    .map((check) => ({
      check,
      workflow: database.workflows.find((workflow) => workflow.agencyId === agencyId && workflow.id === check.workflowId),
    }))
    .filter((item): item is DueCheck => Boolean(item.workflow && !item.workflow.archivedAt))
}

export function recordScheduledCheckJob(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  input: {
    startedAt: string
    checksDue: number
    attempts: ScheduledCheckAttempt[]
  }
) {
  if (input.checksDue === 0 && input.attempts.length === 0) {
    return database
  }

  const completedAt = timestamp()
  let next = database
  let executionFailures = 0

  for (const attempt of input.attempts) {
    if (attempt.result) {
      next = runWorkflowCheck(
        next,
        agencyId,
        userId,
        attempt.workflowId,
        attempt.checkId,
        attempt.result,
        "scheduled_run",
        input.startedAt
      )
      if (attempt.result.status !== "healthy") {
        executionFailures += 1
      }
    } else {
      executionFailures += 1
    }
  }

  const jobRun: CheckJobRun = {
    id: id("job"),
    agencyId,
    status: jobStatus(input.checksDue, input.attempts.length, executionFailures),
    checksDue: input.checksDue,
    checksRun: input.attempts.filter((attempt) => attempt.result).length,
    failures: executionFailures,
    errorMessage: input.attempts
      .map((attempt) =>
        attempt.errorMessage ||
        (attempt.result?.status === "skipped" ? `Inconclusive check: ${attempt.result.errorMessage}` : "")
      )
      .filter(Boolean)
      .join(" ") || "",
    startedAt: input.startedAt,
    completedAt,
    createdAt: completedAt,
  }

  return withAudit(
    {
      ...next,
      checkJobRuns: [jobRun, ...next.checkJobRuns],
    },
    agencyId,
    userId,
    "check_job",
    jobRun.id,
    "completed"
  )
}

export function addIssueNote(database: CoreDatabase, agencyId: string, userId: string, issueId: string, body: string, reportSafe: boolean) {
  const now = timestamp()
  const note: IssueNote = {
    id: id("note"),
    agencyId,
    issueId,
    userId,
    body: body.trim(),
    reportSafe,
    createdAt: now,
  }

  return reconcileReportStaleness(
    withAudit(
      { ...database, issueNotes: [note, ...database.issueNotes] },
      agencyId,
      userId,
      "issue",
      issueId,
      "note_added"
    ),
    now
  )
}

export function recordIssueRepair(database: CoreDatabase, agencyId: string, userId: string, issueId: string, resolutionNote: string) {
  const now = timestamp()
  const existing = database.issues.find((issue) => issue.agencyId === agencyId && issue.id === issueId)
  if (!existing) {
    throw new Error("Issue was not found for this agency.")
  }
  if (existing.status === "resolved") {
    throw new Error("This issue is already verified as resolved.")
  }
  const repaired = recordRepairTransition(existing, resolutionNote, now)
  const nextDatabase = {
    ...database,
    issues: database.issues.map((issue) =>
      issue.agencyId === agencyId && issue.id === issueId ? repaired : issue
    ),
  }

  return addIssueNote(
    withAudit(nextDatabase, agencyId, userId, "issue", issueId, "repair_recorded"),
    agencyId,
    userId,
    issueId,
    resolutionNote,
    true
  )
}

export function updateIssueRecord(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  issueId: string,
  input: Partial<Pick<Issue, "status" | "ownerUserId" | "reportable" | "snoozedUntil" | "reportSafeSummary">>
) {
  if (input.status === "resolved" || input.status === "in_review") {
    throw new Error("Record a repair and complete a newer passing run to resolve an issue.")
  }
  const now = timestamp()
  return reconcileReportStaleness(
    withAudit(
      {
        ...database,
        issues: database.issues.map((issue) =>
          issue.agencyId === agencyId && issue.id === issueId
            ? {
                ...issue,
                ...input,
                ...(input.status
                  ? { repairRecordedAt: null, resolvedAt: null, verificationRunId: null }
                  : {}),
                updatedAt: now,
              }
            : issue
        ),
      },
      agencyId,
      userId,
      "issue",
      issueId,
      "updated"
    ),
    now
  )
}

export function generateReportRecord(
  database: CoreDatabase,
  agency: Agency,
  userId: string,
  input: { clientId: string; periodStart: string; periodEnd: string }
) {
  assertReportLimit(database, agency)
  const client = database.clients.find((item) => item.agencyId === agency.id && item.id === input.clientId)
  if (!client) {
    throw new Error("Client was not found for this agency.")
  }

  const now = timestamp()
  const periodError = validateReportPeriod(input, dateInputValue(new Date(now)))
  if (periodError) {
    throw new Error(periodError.message)
  }
  const reportId = id("rep")
  const built = buildReportSnapshot({
    agency,
    client,
    reportId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    version: 1,
    generatedAt: now,
    workflows: database.workflows,
    checks: database.checks,
    checkRuns: database.checkRuns,
    issues: database.issues,
    issueNotes: database.issueNotes,
  })
  const evidenceError = reportGenerationEvidenceError(built.snapshot.metrics)
  if (evidenceError) {
    throw new Error(evidenceError)
  }
  const report: Report = {
    id: reportId,
    agencyId: agency.id,
    clientId: client.id,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: built.status,
    narrative: built.snapshot.narrative,
    readiness: built.readiness,
    metrics: built.snapshot.metrics,
    snapshotVersion: built.snapshot.version,
    snapshot: built.snapshot,
    evidenceFingerprint: built.snapshot.evidenceFingerprint,
    staleAt: null,
    pdfDataUrl: null,
    pdfStoragePath: null,
    pdfSnapshotVersion: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
  }

  return withAudit(
    {
      ...database,
      reports: [report, ...database.reports],
      reportItems: [...built.reportItems, ...database.reportItems],
    },
    agency.id,
    userId,
    "report",
    report.id,
    "generated"
  )
}

export function refreshReportRecord(database: CoreDatabase, agency: Agency, userId: string, reportId: string) {
  const report = database.reports.find((item) => item.agencyId === agency.id && item.id === reportId)
  if (!report) {
    throw new Error("Report was not found for this agency.")
  }
  const client = database.clients.find((item) => item.agencyId === agency.id && item.id === report.clientId)
  if (!client) {
    throw new Error("Report client was not found for this agency.")
  }
  const now = timestamp()
  const periodError = validateReportPeriod(report, dateInputValue(new Date(now)))
  if (periodError) {
    throw new Error(periodError.message)
  }
  const built = buildReportSnapshot({
    agency,
    client,
    reportId: report.id,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    version: Math.max(0, report.snapshotVersion) + 1,
    generatedAt: now,
    workflows: database.workflows,
    checks: database.checks,
    checkRuns: database.checkRuns,
    issues: database.issues,
    issueNotes: database.issueNotes,
  })
  const evidenceError = reportGenerationEvidenceError(built.snapshot.metrics)
  if (evidenceError) {
    throw new Error(evidenceError)
  }
  const refreshed: Report = {
    ...report,
    status: built.status,
    narrative: built.snapshot.narrative,
    readiness: built.readiness,
    metrics: built.snapshot.metrics,
    snapshotVersion: built.snapshot.version,
    snapshot: built.snapshot,
    evidenceFingerprint: built.snapshot.evidenceFingerprint,
    staleAt: null,
    pdfDataUrl: null,
    pdfSnapshotVersion: null,
    updatedAt: now,
  }

  return withAudit(
    {
      ...database,
      reports: database.reports.map((item) => (item.id === report.id ? refreshed : item)),
      reportItems: [
        ...built.reportItems,
        ...database.reportItems.filter((item) => item.reportId !== report.id),
      ],
    },
    agency.id,
    userId,
    "report",
    report.id,
    "snapshot_refreshed"
  )
}

export function createReportDownload(database: CoreDatabase, agency: Agency, userId: string, reportId: string) {
  const report = database.reports.find((item) => item.agencyId === agency.id && item.id === reportId)
  if (!report) {
    throw new Error("Report was not found for this agency.")
  }
  const client = database.clients.find((item) => item.agencyId === agency.id && item.id === report.clientId)
  if (!client) {
    throw new Error("Report client was not found for this agency.")
  }
  if (!reportSnapshotIsCurrent(report, database) || report.staleAt) {
    throw new Error("This report is stale. Refresh from latest evidence before preparing a PDF.")
  }
  if (report.status !== "ready") {
    throw new Error("Complete report review and a passing verification run before preparing a client PDF.")
  }
  const reportItems = database.reportItems.filter(
    (item) => item.agencyId === agency.id && item.reportId === report.id && item.snapshotVersion === report.snapshotVersion
  )
  const readiness = { ...report.readiness, pdfGenerated: true }
  const pdfDataUrl = createReportDownloadData({ ...report, readiness }, client, agency.name, reportItems)
  const now = timestamp()

  return withAudit(
    {
      ...database,
      reports: database.reports.map((item) =>
        item.agencyId === agency.id && item.id === reportId
          ? { ...item, pdfDataUrl, readiness, pdfSnapshotVersion: item.snapshotVersion, updatedAt: now }
          : item
      ),
    },
    agency.id,
    userId,
    "report",
    reportId,
    "download_prepared"
  )
}

export function updateReportNarrative(
  database: CoreDatabase,
  agency: Agency,
  userId: string,
  reportId: string,
  narrative: string
) {
  const report = database.reports.find((item) => item.agencyId === agency.id && item.id === reportId)
  if (!report) {
    throw new Error("Report was not found for this agency.")
  }
  if (!report.snapshot) {
    throw new Error("Refresh this legacy report before editing its narrative.")
  }
  if (report.staleAt || !reportSnapshotIsCurrent(report, database)) {
    throw new Error("This report is stale. Refresh from latest evidence before editing its narrative.")
  }
  const client = database.clients.find((item) => item.agencyId === agency.id && item.id === report.clientId)
  if (!client) {
    throw new Error("Report client was not found for this agency.")
  }
  const candidateGeneratedAt = timestamp()
  const previousGeneratedAt = new Date(report.snapshot.generatedAt).getTime()
  const candidateTime = new Date(candidateGeneratedAt).getTime()
  const now = Number.isFinite(previousGeneratedAt) && candidateTime <= previousGeneratedAt
    ? new Date(previousGeneratedAt + 1).toISOString()
    : candidateGeneratedAt
  const periodError = validateReportPeriod(report, dateInputValue(new Date(now)))
  if (periodError) {
    throw new Error(periodError.message)
  }
  const built = buildReportSnapshot({
    agency,
    client,
    reportId: report.id,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    version: Math.max(0, report.snapshotVersion) + 1,
    generatedAt: now,
    workflows: database.workflows,
    checks: database.checks,
    checkRuns: database.checkRuns,
    issues: database.issues,
    issueNotes: database.issueNotes,
  })
  const snapshot = { ...built.snapshot, narrative }
  const readiness = evaluateReportReadiness(snapshot, narrative)
  const status = reportStatusFromReadiness(readiness)

  return withAudit(
    {
      ...database,
      reports: database.reports.map((item) =>
        item.agencyId === agency.id && item.id === reportId
          ? {
              ...item,
              narrative,
              snapshot,
              snapshotVersion: snapshot.version,
              metrics: snapshot.metrics,
              evidenceFingerprint: snapshot.evidenceFingerprint,
              readiness,
              status,
              pdfDataUrl: null,
              pdfStoragePath: null,
              pdfSnapshotVersion: null,
              staleAt: null,
              updatedAt: now,
            }
          : item
      ),
      reportItems: [
        ...built.reportItems,
        ...database.reportItems.filter((item) => item.reportId !== reportId),
      ],
    },
    agency.id,
    userId,
    "report",
    reportId,
    "narrative_updated"
  )
}

export function activationChecklist(database: CoreDatabase, agencyId: string): ActivationChecklist {
  const clients = database.clients.filter((client) => client.agencyId === agencyId && !client.archivedAt)
  const workflows = database.workflows.filter((workflow) => workflow.agencyId === agencyId && !workflow.archivedAt)
  const activeChecks = database.checks.filter(
    (check) => check.agencyId === agencyId && check.enabled && !check.pendingSetup
  )
  const coveredCheckIds = new Set(
    database.checkRuns
      .filter((run) => run.agencyId === agencyId && isServiceIssuedCheckRun(run))
      .map((run) => run.checkId)
  )
  const issues = database.issues.filter((issue) => issue.agencyId === agencyId)
  const reports = database.reports.filter((report) => report.agencyId === agencyId)

  return {
    agencyCreated: database.agencies.some((agency) => agency.id === agencyId),
    clientCreated: clients.length > 0,
    workflowConnected: workflows.length > 0,
    firstCheckRun: activeChecks.length > 0 && activeChecks.every((check) => coveredCheckIds.has(check.id)),
    issueCreated: issues.length > 0,
    issueResolved: issues.some((issue) => issue.status === "resolved"),
    reportGenerated: reports.length > 0,
  }
}

export function isActivationChecklistComplete(checklist: ActivationChecklist | null | undefined) {
  return Boolean(
    checklist?.agencyCreated &&
      checklist.clientCreated &&
      checklist.workflowConnected &&
      checklist.firstCheckRun &&
      checklist.reportGenerated
  )
}

export function scopedData(database: CoreDatabase, agencyId: string) {
  return {
    agencyId,
    memberships: database.memberships.filter((membership) => membership.agencyId === agencyId),
    clients: database.clients.filter((client) => client.agencyId === agencyId),
    workflows: database.workflows.filter((workflow) => workflow.agencyId === agencyId),
    checks: database.checks.filter((check) => check.agencyId === agencyId),
    checkRuns: database.checkRuns.filter((run) => run.agencyId === agencyId),
    checkJobRuns: database.checkJobRuns.filter((run) => run.agencyId === agencyId),
    issues: database.issues.filter((issue) => issue.agencyId === agencyId),
    issueNotes: database.issueNotes.filter((note) => note.agencyId === agencyId),
    reports: database.reports.filter((report) => report.agencyId === agencyId),
    reportItems: database.reportItems.filter((item) => item.agencyId === agencyId),
    auditEvents: database.auditEvents.filter((event) => event.agencyId === agencyId),
  }
}

function createCheckRunRecord(
  agencyId: string,
  clientId: string,
  workflowId: string,
  checkId: string,
  result: EndpointTestResult,
  startedAt: string,
  completedAt = startedAt
): CheckRun {
  return {
    id: id("run"),
    agencyId,
    clientId,
    workflowId,
    checkId,
    // Local mode is an in-memory runner simulation. Database sync deliberately
    // omits this field, so a browser can never promote a persisted run to trusted
    // evidence; PostgreSQL applies the legacy_browser default instead.
    evidenceOrigin: SERVICE_ISSUED_EVIDENCE_ORIGIN,
    status: result.status,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    assertionResults: sanitizeAssertionResults(result.assertionResults),
    resultJson: endpointResultJson(result),
    safeResponseSummary: result.safeResponseSummary,
    errorMessage: result.errorMessage,
    startedAt,
    completedAt,
    createdAt: completedAt,
  }
}

function endpointPluginConfig(input: WorkflowSetupInput) {
  return {
    expectedStatus: input.expectedStatus,
    timeoutSeconds: input.timeoutSeconds,
    maxLatencyMs: input.maxLatencyMs,
  }
}

function savedWorkflowSetupInput(input: WorkflowSetupInput, allowEmptyEndpoint = false): WorkflowSetupInput {
  if (input.storeRawResponse) {
    throw new Error("Raw response storage is disabled for saved monitors.")
  }
  const savedMonitor = assertSavedMonitorPolicy(input, { allowEmptyEndpoint })
  const assertions = assertSafeSavedAssertions(input.assertions)
  return { ...input, ...savedMonitor, assertions, storeRawResponse: false }
}

function endpointResultJson(result: EndpointTestResult): Record<string, unknown> {
  void result
  return {}
}

function withIssueForRun(
  database: CoreDatabase,
  agencyId: string,
  userId: string,
  workflow: Workflow,
  check: Check,
  run: CheckRun
): CoreDatabase {
  if (run.status === "healthy") {
    const pending = database.issues.filter((issue) => canVerifyRepair(issue, run))
    return pending.reduce((nextDatabase, pendingIssue) => {
      const verified = verifiedResolutionTransition(pendingIssue, run)
      return withAudit(
        {
          ...nextDatabase,
          issues: nextDatabase.issues.map((issue) => (issue.id === pendingIssue.id ? verified : issue)),
        },
        agencyId,
        userId,
        "issue",
        pendingIssue.id,
        "resolved_by_passing_run"
      )
    }, database)
  }

  if (run.status === "skipped") {
    return database
  }

  const invalidatedIssueIds = new Set(
    database.issues
      .filter(
        (issue) =>
          issue.agencyId === agencyId &&
          issue.checkId === check.id &&
          failureInvalidatesIssueResolution(issue, run)
      )
      .map((issue) => issue.id)
  )
  const invalidatedDatabase = [...invalidatedIssueIds].reduce((nextDatabase, issueId) => {
    const issue = nextDatabase.issues.find((item) => item.id === issueId)
    if (!issue) return nextDatabase
    const invalidated = invalidatedIssueResolution(issue)

    return withAudit(
      {
        ...nextDatabase,
        issues: nextDatabase.issues.map((item) =>
          item.id === issueId
            ? {
                ...item,
                ...invalidated,
                updatedAt: run.completedAt,
              }
            : item
        ),
      },
      agencyId,
      userId,
      "issue",
      issueId,
      "verification_invalidated_by_failure"
    )
  }, database)

  const dedupeKey = issueDedupeKey(check.id, run)
  const existing = invalidatedDatabase.issues.find((issue) => issue.agencyId === agencyId && issue.dedupeKey === dedupeKey)
  const now = run.completedAt

  if (existing) {
    if (
      ["resolved", "in_review"].includes(existing.status) &&
      !failureInvalidatesIssueResolution(existing, run)
    ) {
      return invalidatedDatabase
    }

    const transition = nextIssueOccurrence(existing)
    return withAudit(
      {
        ...invalidatedDatabase,
        issues: invalidatedDatabase.issues.map((issue) =>
          issue.id === existing.id
            ? {
                ...issue,
                checkRunId: run.id,
                status: transition.status,
                occurrenceCount: transition.occurrenceCount,
                description: issueDescription(workflow, run),
                repairRecordedAt: transition.repairRecordedAt,
                resolvedAt: transition.resolvedAt,
                verificationRunId: transition.verificationRunId,
                resolutionNote: transition.resolutionNote,
                reportSafeSummary: transition.reportSafeSummary,
                snoozedUntil: transition.snoozedUntil,
                updatedAt: now,
              }
            : issue
        ),
      },
      agencyId,
      userId,
      "issue",
      existing.id,
      transition.reopened || invalidatedIssueIds.has(existing.id) ? "reopened_occurrence" : "deduped_occurrence"
    )
  }

  const issue: Issue = {
    id: id("iss"),
    agencyId,
    clientId: workflow.clientId,
    workflowId: workflow.id,
    checkRunId: run.id,
    checkId: check.id,
    dedupeKey,
    severity: run.status === "failed" ? "high" : "medium",
    status: "open",
    title: `${workflow.name} ${run.status === "failed" ? "failed" : "degraded"}`,
    description: issueDescription(workflow, run),
    suggestedAction: run.statusCode === 401 ? "Check authorization headers and rotate credentials." : "Review the endpoint response and rerun the source check.",
    ownerUserId: userId,
    reportable: true,
    occurrenceCount: 1,
    snoozedUntil: null,
    repairRecordedAt: null,
    resolvedAt: null,
    verificationRunId: null,
    resolutionNote: "",
    reportSafeSummary: "",
    createdAt: now,
    updatedAt: now,
  }

  return withAudit(
    { ...invalidatedDatabase, issues: [issue, ...invalidatedDatabase.issues] },
    agencyId,
    userId,
    "issue",
    issue.id,
    "auto_created"
  )
}

function withAudit(
  database: CoreDatabase,
  agencyId: string,
  actorUserId: string,
  entityType: string,
  entityId: string,
  action: string
): CoreDatabase {
  const event: AuditEvent = {
    id: id("audit"),
    agencyId,
    actorUserId,
    entityType,
    entityId,
    action,
    metadata: {},
    createdAt: timestamp(),
  }

  return {
    ...database,
    auditEvents: [event, ...database.auditEvents],
  }
}

function issueDescription(workflow: Workflow, run: CheckRun) {
  return `${workflow.name} produced a ${run.status} check run${run.statusCode ? ` with HTTP ${run.statusCode}` : ""}. ${run.errorMessage || run.safeResponseSummary}`
}

function healthScore(status: EndpointTestResult["status"]) {
  if (status === "healthy") return 100
  if (status === "degraded") return 68
  if (status === "skipped") return 0
  return 24
}

function workflowStatus(status: EndpointTestResult["status"]): Workflow["status"] {
  if (status === "healthy" || status === "degraded" || status === "failed") {
    return status
  }

  return "pending"
}

function jobStatus(checksDue: number, attempts: number, failures: number): CheckJobRun["status"] {
  if (checksDue === 0) return "skipped"
  if (attempts === 0 || attempts === failures) return "failed"
  if (failures > 0 || attempts < checksDue) return "partial"
  return "success"
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "workspace"
}

function addMinutes(value: string, minutes: number) {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString()
}

function assertClientLimit(database: CoreDatabase, agencyId: string) {
  const agency = database.agencies.find((item) => item.id === agencyId)
  const plan = agency ? getEffectiveBillingPlan(agency) : getBillingPlan("free")
  const limit = plan.limits.clients
  if (limit === null) return

  const activeClients = database.clients.filter((client) => client.agencyId === agencyId && !client.archivedAt).length
  if (activeClients >= limit) {
    throw new Error(`${plan.name} allows up to ${limit} active client${limit === 1 ? "" : "s"}. Upgrade before adding another client.`)
  }
}

function assertWorkflowLimit(database: CoreDatabase, agencyId: string, clientId: string) {
  const agency = database.agencies.find((item) => item.id === agencyId)
  const plan = agency ? getEffectiveBillingPlan(agency) : getBillingPlan("free")
  const workflows = database.workflows.filter((workflow) => workflow.agencyId === agencyId && !workflow.archivedAt)
  const workflowLimit = plan.limits.workflows

  if (workflowLimit !== null && workflows.length >= workflowLimit) {
    throw new Error(`${plan.name} allows up to ${workflowLimit} active workflow${workflowLimit === 1 ? "" : "s"}. Upgrade before adding another workflow.`)
  }

  const perClientLimit = plan.workflowsPerClient
  if (perClientLimit === null) return

  const clientWorkflows = workflows.filter((workflow) => workflow.clientId === clientId).length
  if (clientWorkflows >= perClientLimit) {
    throw new Error(`${plan.name} allows up to ${perClientLimit} workflow${perClientLimit === 1 ? "" : "s"} per client.`)
  }
}

function assertReportLimit(database: CoreDatabase, agency: Agency) {
  const plan = getEffectiveBillingPlan(agency)
  const limit = plan.limits.reportsPerMonth
  if (limit === null) return

  const monthStart = currentMonthToDate(new Date()).periodStart
  const reportsThisMonth = database.reports.filter((report) =>
    report.agencyId === agency.id &&
    report.createdAt >= monthStart
  ).length

  if (reportsThisMonth >= limit) {
    throw new Error(`${plan.name} allows up to ${limit} report${limit === 1 ? "" : "s"} per month. Upgrade before generating another report.`)
  }
}

function timestamp() {
  return new Date().toISOString()
}

function id(_prefix: string) {
  void _prefix
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return "10000000-0000-4000-8000-000000000000".replace(/[018]/g, (value) =>
    (Number(value) ^ (Math.random() * 16) >> (Number(value) / 4)).toString(16)
  )
}
