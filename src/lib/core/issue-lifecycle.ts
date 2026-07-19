import type { AssertionResult, CheckRun, CheckStatus, Issue, IssueStatus } from "./types.ts"
import { isServiceIssuedCheckRun } from "./evidence-provenance.ts"

type IssueFailureIdentity = {
  status: CheckStatus
  errorMessage: string
  assertionResults: AssertionResult[]
}

type ExistingIssueOccurrence = {
  status: IssueStatus
  occurrenceCount: number
  repairRecordedAt: string | null
  resolvedAt: string | null
  verificationRunId: string | null
  resolutionNote: string
  reportSafeSummary: string
  snoozedUntil: string | null
}

export type IssueOccurrenceTransition = ExistingIssueOccurrence & {
  reopened: boolean
}

type IssueResolutionState = Pick<
  ExistingIssueOccurrence,
  | "status"
  | "repairRecordedAt"
  | "resolvedAt"
  | "verificationRunId"
  | "resolutionNote"
  | "reportSafeSummary"
  | "snoozedUntil"
>

type PersistedIssueOccurrence = {
  status: IssueStatus
  occurrence_count: number
  repair_recorded_at: string | null
  resolved_at: string | null
  verification_run_id: string | null
  resolution_note: string
  report_safe_summary: string
  snoozed_until: string | null
}

export function issueDedupeKey(checkId: string, failure: IssueFailureIdentity) {
  const failedAssertion = failure.assertionResults.find((assertion) => !assertion.passed)
  const reason = failure.errorMessage || failedAssertion?.label || failure.status
  return `${checkId}:${reason}`
}

export function nextIssueOccurrence(existing: ExistingIssueOccurrence): IssueOccurrenceTransition {
  const reopened = existing.status === "resolved" || existing.status === "ignored" || existing.status === "in_review"

  return {
    status: reopened ? "open" : existing.status,
    occurrenceCount: Math.max(1, Number(existing.occurrenceCount) || 1) + 1,
    repairRecordedAt: reopened ? null : existing.repairRecordedAt,
    resolvedAt: null,
    verificationRunId: null,
    resolutionNote: reopened ? "" : existing.resolutionNote,
    reportSafeSummary: reopened ? "" : existing.reportSafeSummary,
    snoozedUntil: reopened ? null : existing.snoozedUntil,
    reopened,
  }
}

export function failureInvalidatesIssueResolution(
  issue: Pick<IssueResolutionState, "status" | "repairRecordedAt">,
  run: Pick<CheckRun, "evidenceOrigin" | "status" | "startedAt">
) {
  if (
    !isServiceIssuedCheckRun(run)
    || run.status === "healthy"
    || run.status === "skipped"
    || !["resolved", "in_review"].includes(issue.status)
  ) {
    return false
  }

  if (!issue.repairRecordedAt) {
    return true
  }

  const runStartedAt = new Date(run.startedAt).getTime()
  const repairRecordedAt = new Date(issue.repairRecordedAt).getTime()
  if (!Number.isFinite(runStartedAt)) {
    return false
  }

  return !Number.isFinite(repairRecordedAt) || runStartedAt > repairRecordedAt
}

export function invalidatedIssueResolution(existing: IssueResolutionState): IssueResolutionState {
  return {
    ...existing,
    status: "open",
    repairRecordedAt: null,
    resolvedAt: null,
    verificationRunId: null,
    resolutionNote: "",
    reportSafeSummary: "",
    snoozedUntil: null,
  }
}

export function nextPersistedIssueOccurrence(existing: PersistedIssueOccurrence) {
  const transition = nextIssueOccurrence({
    status: existing.status,
    occurrenceCount: existing.occurrence_count,
    repairRecordedAt: existing.repair_recorded_at,
    resolvedAt: existing.resolved_at,
    verificationRunId: existing.verification_run_id,
    resolutionNote: existing.resolution_note,
    reportSafeSummary: existing.report_safe_summary,
    snoozedUntil: existing.snoozed_until,
  })

  return {
    status: transition.status,
    occurrence_count: transition.occurrenceCount,
    repair_recorded_at: transition.repairRecordedAt,
    resolved_at: transition.resolvedAt,
    verification_run_id: transition.verificationRunId,
    resolution_note: transition.resolutionNote,
    report_safe_summary: transition.reportSafeSummary,
    snoozed_until: transition.snoozedUntil,
    reopened: transition.reopened,
  }
}

export function recordRepairTransition(issue: Issue, note: string, now: string) {
  const normalizedNote = note.trim()
  if (!normalizedNote) {
    throw new Error("Add a client-safe repair note before requesting verification.")
  }

  return {
    ...issue,
    status: "in_review" as const,
    repairRecordedAt: now,
    resolvedAt: null,
    verificationRunId: null,
    resolutionNote: normalizedNote,
    reportSafeSummary: normalizedNote,
    snoozedUntil: null,
    updatedAt: now,
  }
}

export function canVerifyRepair(issue: Issue, run: CheckRun) {
  if (
    !isServiceIssuedCheckRun(run) ||
    issue.agencyId !== run.agencyId ||
    issue.checkId !== run.checkId ||
    issue.status !== "in_review" ||
    !issue.repairRecordedAt ||
    run.status !== "healthy"
  ) {
    return false
  }

  return new Date(run.startedAt).getTime() > new Date(issue.repairRecordedAt).getTime()
}

export function verifiedResolutionTransition(issue: Issue, run: CheckRun) {
  if (!canVerifyRepair(issue, run)) {
    return issue
  }

  return {
    ...issue,
    status: "resolved" as const,
    resolvedAt: run.completedAt,
    verificationRunId: run.id,
    updatedAt: run.completedAt,
  }
}

export function createIssuePersistenceReference() {
  return `issue-${crypto.randomUUID()}`
}

export function safeIssuePersistenceError(reference: string) {
  return new Error(
    `Maintain Flow could not save the related issue update. Retry the check. If the problem continues, contact support with reference ${reference}.`
  )
}
