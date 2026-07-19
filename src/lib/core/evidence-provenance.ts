import type { CheckRun, CheckRunEvidenceOrigin, CheckStatus, CoreDatabase } from "./types.ts"

export const SERVICE_ISSUED_EVIDENCE_ORIGIN = "service" as const
export const LEGACY_BROWSER_EVIDENCE_ORIGIN = "legacy_browser" as const

export function normalizeCheckRunEvidenceOrigin(value: unknown): CheckRunEvidenceOrigin {
  return value === SERVICE_ISSUED_EVIDENCE_ORIGIN
    ? SERVICE_ISSUED_EVIDENCE_ORIGIN
    : LEGACY_BROWSER_EVIDENCE_ORIGIN
}

export function isServiceIssuedCheckRun(
  run: Pick<CheckRun, "evidenceOrigin">
): run is Pick<CheckRun, "evidenceOrigin"> & { evidenceOrigin: typeof SERVICE_ISSUED_EVIDENCE_ORIGIN } {
  return run.evidenceOrigin === SERVICE_ISSUED_EVIDENCE_ORIGIN
}

export function workflowAssuranceFromServiceRuns(
  activeChecks: CoreDatabase["checks"],
  runs: CheckRun[]
) {
  const latestRunByCheck = new Map<string, CheckRun>()
  const latestConclusiveRunByCheck = new Map<string, CheckRun>()

  ;[...runs]
    .filter(isServiceIssuedCheckRun)
    .sort(compareNewestRun)
    .forEach((run) => {
      const key = checkIdentity(run)
      if (!latestRunByCheck.has(key)) latestRunByCheck.set(key, run)
      if (run.status !== "skipped" && !latestConclusiveRunByCheck.has(key)) {
        latestConclusiveRunByCheck.set(key, run)
      }
    })

  const checkStates = activeChecks.map((check) => {
    const key = `${check.agencyId}:${check.id}`
    const latestRun = latestRunByCheck.get(key)
    const latestConclusiveRun = latestConclusiveRunByCheck.get(key)
    const status = !latestRun
      ? "pending" as const
      : latestRun.status !== "skipped"
        ? workflowStatus(latestRun.status)
        : latestConclusiveRun?.status === "failed" || latestConclusiveRun?.status === "degraded"
          ? workflowStatus(latestConclusiveRun.status)
          : "pending" as const
    return { checkId: check.id, status, latestRun, latestConclusiveRun }
  })
  const weakest = checkStates.reduce<(typeof checkStates)[number] | undefined>((current, state) =>
    !current || workflowStatusRisk(state.status) > workflowStatusRisk(current.status) ? state : current
  , undefined)
  const latestRuns = checkStates
    .map((state) => state.latestRun)
    .filter((run): run is CheckRun => Boolean(run))
  const lastRunAt = latestRuns.reduce<string | null>((latest, run) =>
    !latest || new Date(run.completedAt).getTime() > new Date(latest).getTime()
      ? run.completedAt
      : latest
  , null)

  return {
    status: weakest?.status ?? "pending" as const,
    healthScore: weakest ? workflowHealthScore(weakest.status) : 0,
    lastRunAt: activeChecks.length ? lastRunAt : null,
    checkStates,
  }
}

/**
 * Builds the customer-facing assurance view. Legacy rows stay intact in
 * PostgreSQL for audit/recovery, but cannot contribute runs, issues, health,
 * activation, trends, or report proof in the application.
 */
export function serviceIssuedAssuranceView(database: CoreDatabase): CoreDatabase {
  const checkRuns = database.checkRuns.filter(isServiceIssuedCheckRun)
  const runById = new Map(checkRuns.map((run) => [run.id, run]))
  const latestRunByCheck = new Map<string, CheckRun>()
  const latestConclusiveRunByCheck = new Map<string, CheckRun>()
  const activeChecksByWorkflow = new Map<string, CoreDatabase["checks"]>()

  database.checks.forEach((check) => {
    if (!check.enabled || check.pendingSetup) return
    const key = `${check.agencyId}:${check.workflowId}`
    activeChecksByWorkflow.set(key, [
      ...(activeChecksByWorkflow.get(key) ?? []),
      check,
    ])
  })

  ;[...checkRuns]
    .sort(compareNewestRun)
    .forEach((run) => {
      const key = checkIdentity(run)
      if (!latestRunByCheck.has(key)) latestRunByCheck.set(key, run)
      if (run.status !== "skipped" && !latestConclusiveRunByCheck.has(key)) {
        latestConclusiveRunByCheck.set(key, run)
      }
    })

  const workflows = database.workflows.map((workflow) => {
    const activeChecks = activeChecksByWorkflow.get(`${workflow.agencyId}:${workflow.id}`) ?? []
    const assurance = workflowAssuranceFromServiceRuns(activeChecks, checkRuns)

    return {
      ...workflow,
      status: assurance.status,
      healthScore: assurance.healthScore,
      lastCheckRunAt: assurance.lastRunAt,
    }
  })

  const checks = database.checks.map((check) => ({
    ...check,
    lastRunAt: latestRunByCheck.get(`${check.agencyId}:${check.id}`)?.completedAt ?? null,
  }))
  const issues = database.issues.flatMap((issue) => {
    const sourceRun = runById.get(issue.checkRunId)
    if (!sourceRun || !runMatchesIssue(sourceRun, issue)) return []
    const verificationRun = issue.verificationRunId ? runById.get(issue.verificationRunId) : null
    const verificationMatches = Boolean(verificationRun && runMatchesIssue(verificationRun, issue))
    if (issue.status !== "resolved") {
      return [verificationMatches ? issue : { ...issue, verificationRunId: null }]
    }
    const latestConclusiveRun = latestConclusiveRunByCheck.get(issueIdentity(issue))
    const verified = Boolean(
      verificationRun
      && verificationMatches
      && verificationRun.status === "healthy"
      && issue.repairRecordedAt
      && issue.resolutionNote.trim()
      && new Date(verificationRun.startedAt).getTime() > new Date(issue.repairRecordedAt).getTime()
      && new Date(issue.resolvedAt ?? "").getTime() === new Date(verificationRun.completedAt).getTime()
      && latestConclusiveRun?.status === "healthy"
      && new Date(latestConclusiveRun.startedAt).getTime() > new Date(issue.repairRecordedAt).getTime()
    )
    if (verified) return [issue]
    const awaitingVerification = Boolean(issue.repairRecordedAt && issue.resolutionNote.trim())
    return [{
      ...issue,
      status: awaitingVerification ? "in_review" as const : "open" as const,
      resolvedAt: null,
      verificationRunId: null,
    }]
  })
  const issueIds = new Set(issues.map((issue) => issue.id))

  return {
    ...database,
    workflows,
    checks,
    checkRuns,
    issues,
    issueNotes: database.issueNotes.filter((note) => issueIds.has(note.issueId)),
  }
}

function checkIdentity(run: Pick<CheckRun, "agencyId" | "checkId">) {
  return `${run.agencyId}:${run.checkId}`
}

function issueIdentity(issue: CoreDatabase["issues"][number]) {
  return `${issue.agencyId}:${issue.checkId}`
}

function runMatchesIssue(run: CheckRun, issue: CoreDatabase["issues"][number]) {
  return run.agencyId === issue.agencyId
    && run.clientId === issue.clientId
    && run.workflowId === issue.workflowId
    && run.checkId === issue.checkId
}

function compareNewestRun(left: CheckRun, right: CheckRun) {
  return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
    || new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime()
    || right.id.localeCompare(left.id)
}

function workflowStatus(status: CheckStatus) {
  return status === "healthy" ? "healthy" as const
    : status === "degraded" ? "degraded" as const
      : status === "failed" ? "failed" as const
        : "pending" as const
}

function workflowStatusRisk(status: "healthy" | "degraded" | "failed" | "pending") {
  return status === "failed" ? 4 : status === "degraded" ? 3 : status === "pending" ? 2 : 1
}

function workflowHealthScore(status: "healthy" | "degraded" | "failed" | "pending") {
  return status === "healthy" ? 100 : status === "degraded" ? 68 : status === "failed" ? 24 : 0
}
