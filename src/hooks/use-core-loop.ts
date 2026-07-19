"use client"

import type { AuthUser } from "@/lib/auth-storage"
import { trackProductEvent } from "@/lib/analytics/product-events"
import type { ProductEventMetadata, ProductEventName } from "@/lib/analytics/product-events.shared"
import {
  addIssueNote,
  activationChecklist,
  archiveClientRecord,
  createAgencyWorkspace,
  createClientRecord,
  createPendingWorkflow,
  createReportDownload,
  createWorkflowReadyForFirstRun,
  createWorkflowWithFirstRun,
  emptyCoreDatabase,
  generateReportRecord,
  getUserAgency,
  readCoreDatabase,
  recordScheduledCheckJob,
  recordIssueRepair,
  refreshReportRecord,
  runWorkflowCheck,
  scopedData,
  selectDueChecks,
  updateReportNarrative,
  updateIssueRecord,
  updateAgency,
  updateClientRecord,
  type WorkflowSetupInput,
  writeCoreDatabase,
} from "@/lib/core/local-store"
import type { CoreDatabase, EndpointTestInput, EndpointTestResult } from "@/lib/core/types"
import { acceptedEndpointApiResult } from "@/lib/core/endpoint-api-result"
import { endpointInputFromSavedCheck } from "@/lib/core/saved-check-config"
import { createAgencyWorkspaceInSupabase, loadCoreDatabaseFromSupabase, syncCoreDatabaseToSupabase, updateAgencyInSupabase } from "@/lib/supabase/core-sync"
import { getSupabaseConfig } from "@/lib/supabase/config"
import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"
import { prepareReportPdfFromApi } from "@/lib/supabase/report-storage"
import { useCallback, useEffect, useMemo, useState } from "react"

export function useCoreLoop(user: AuthUser | null) {
  const useSupabase = getSupabaseConfig().enabled
  const userId = user?.id ?? null
  const [database, setDatabase] = useState<CoreDatabase>(() =>
    typeof window === "undefined" || useSupabase ? emptyCoreDatabase() : readCoreDatabase()
  )
  const [loading, setLoading] = useState(useSupabase)
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null)
  const [creatingAgency, setCreatingAgency] = useState(false)
  const [syncError, setSyncError] = useState("")
  const agency = useMemo(() => (user ? getUserAgency(database, user.id) : null), [database, user])
  const data = useMemo(() => (agency ? scopedData(database, agency.id) : null), [agency, database])
  const checklist = useMemo(() => (agency ? activationChecklist(database, agency.id) : null), [agency, database])
  const initialSupabaseLoadPending = useSupabase && !!user && loadedUserId !== user.id
  const workspaceLoading = loading || initialSupabaseLoadPending
  const trackCoreEvent = useCallback(
    (eventName: ProductEventName, metadata: ProductEventMetadata = {}, agencyId = agency?.id ?? null) => {
      trackProductEvent({ eventName, agencyId, metadata })
    },
    [agency?.id]
  )

  useEffect(() => {
    if (!useSupabase) {
      setLoading(false)
      setLoadedUserId(user?.id ?? null)
      return
    }

    if (!user) {
      setDatabase(emptyCoreDatabase())
      setLoading(false)
      setLoadedUserId(null)
      return
    }

    let cancelled = false
    setLoading(true)
    loadCoreDatabaseFromSupabase(user.id)
      .then((nextDatabase) => {
        if (!cancelled) {
          setDatabase(nextDatabase)
          writeCoreDatabase(nextDatabase)
          setSyncError("")
          setLoadedUserId(user.id)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSyncError(error instanceof Error ? error.message : "Could not load Supabase data.")
          setLoadedUserId(user.id)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [useSupabase, user])

  const applyDatabase = useCallback((nextDatabase: CoreDatabase) => {
    setDatabase(nextDatabase)
    writeCoreDatabase(nextDatabase)
    return nextDatabase
  }, [])

  const reloadWorkspace = useCallback(async () => {
    if (!userId) {
      const nextDatabase = emptyCoreDatabase()
      applyDatabase(nextDatabase)
      setLoadedUserId(null)
      setSyncError("")
      return nextDatabase
    }

    try {
      const nextDatabase = useSupabase ? await loadCoreDatabaseFromSupabase(userId) : readCoreDatabase()
      applyDatabase(nextDatabase)
      setLoadedUserId(userId)
      setSyncError("")
      return nextDatabase
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not reload workspace data.")
      throw error
    }
  }, [applyDatabase, useSupabase, userId])

  const persistDatabase = useCallback(async (nextDatabase: CoreDatabase) => {
    const previousDatabase = readCoreDatabase()
    applyDatabase(nextDatabase)

    if (!useSupabase || !user) {
      return nextDatabase
    }

    const agencyIds = nextDatabase.memberships
      .filter((membership) => membership.userId === user.id)
      .map((membership) => membership.agencyId)

    try {
      await syncCoreDatabaseToSupabase(nextDatabase, agencyIds, previousDatabase)
      const persistedDatabase = await loadCoreDatabaseFromSupabase(user.id)
      applyDatabase(persistedDatabase)
      setSyncError("")
      return persistedDatabase
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not sync Supabase data.")
      try {
        applyDatabase(await loadCoreDatabaseFromSupabase(user.id))
      } catch {
        // Keep the visible sync error if the recovery reload also fails.
      }
      throw error
    }
  }, [applyDatabase, useSupabase, user])

  const createAgency = useCallback(
    async (input: { name: string; slug: string }) => {
      if (!user) throw new Error("Sign in before creating an agency.")
      setCreatingAgency(true)
      try {
        if (useSupabase) {
          const nextDatabase = await createAgencyWorkspaceInSupabase(user, input)
          applyDatabase(nextDatabase)
          setLoadedUserId(user.id)
          setSyncError("")
          const nextAgencyId = nextDatabase.memberships.find((membership) => membership.userId === user.id)?.agencyId ?? null
          trackCoreEvent("workspace_created", { authMode: "supabase" }, nextAgencyId)
          return nextDatabase
        }
        const nextDatabase = await persistDatabase(createAgencyWorkspace(readCoreDatabase(), user, input))
        const nextAgencyId = nextDatabase.memberships.find((membership) => membership.userId === user.id)?.agencyId ?? null
        trackCoreEvent("workspace_created", { authMode: "local" }, nextAgencyId)
        return nextDatabase
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : "Could not create the agency workspace.")
        throw error
      } finally {
        setCreatingAgency(false)
      }
    },
    [applyDatabase, persistDatabase, trackCoreEvent, useSupabase, user]
  )

  const saveAgency = useCallback(
    async (input: Parameters<typeof updateAgency>[2]) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const previousDatabase = readCoreDatabase()
      const previousAgency = previousDatabase.agencies.find((item) => item.id === agency.id)
      const nextDatabase = updateAgency(previousDatabase, agency.id, input, user.id)
      applyDatabase(nextDatabase)
      if (!useSupabase) {
        trackCoreEvent("agency_profile_updated", { authMode: "local" })
        return nextDatabase
      }

      const nextAgency = nextDatabase.agencies.find((item) => item.id === agency.id)
      if (!nextAgency) {
        throw new Error("Agency was not found.")
      }

      try {
        await updateAgencyInSupabase(nextAgency, previousAgency?.updatedAt)
        const persistedDatabase = await loadCoreDatabaseFromSupabase(user.id)
        applyDatabase(persistedDatabase)
        setSyncError("")
        trackCoreEvent("agency_profile_updated", { authMode: "supabase" })
        return persistedDatabase
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : "Could not save agency profile.")
        try {
          applyDatabase(await loadCoreDatabaseFromSupabase(user.id))
        } catch {
          // Keep the visible sync error if the recovery reload also fails.
        }
        throw error
      }
    },
    [agency, applyDatabase, trackCoreEvent, useSupabase, user]
  )

  const createClient = useCallback(
    async (input: Parameters<typeof createClientRecord>[3]) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const currentDatabase = readCoreDatabase()
      const hadClient = currentDatabase.clients.some((client) => client.agencyId === agency.id && !client.archivedAt)
      const nextDatabase = await persistDatabase(createClientRecord(currentDatabase, agency.id, user.id, input))
      trackCoreEvent("client_created", { reportCadence: input.reportCadence ?? "monthly" })
      if (!hadClient) {
        trackCoreEvent("first_client_created", { reportCadence: input.reportCadence ?? "monthly" })
      }
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const updateClient = useCallback(
    async (clientId: string, input: Parameters<typeof updateClientRecord>[4]) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(updateClientRecord(readCoreDatabase(), agency.id, user.id, clientId, input))
      trackCoreEvent("client_updated")
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const archiveClient = useCallback(
    async (clientId: string) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(archiveClientRecord(readCoreDatabase(), agency.id, user.id, clientId))
      trackCoreEvent("client_archived")
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const testEndpoint = useCallback(async (input: EndpointTestInput) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (useSupabase) {
      const token = await getValidSupabaseAccessToken()
      if (!token) {
        throw new Error("Sign in before testing an endpoint.")
      }
      headers.Authorization = `Bearer ${token}`
    }

    trackCoreEvent("workflow_test_started", {
      method: input.method,
      expectedStatus: input.expectedStatus,
    })

    try {
      const response = await fetch("/api/checks/test", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...input,
          rateLimitKey: agency && user ? `${agency.id}:${user.id}` : input.rateLimitKey,
        }),
      })
      const result = (await response.json()) as EndpointTestResult
      acceptedEndpointApiResult(response.ok, result)
      const testEvent = result.status === "skipped"
        ? "workflow_test_inconclusive"
        : result.status === "healthy" || result.status === "degraded"
          ? "workflow_test_succeeded"
          : "workflow_test_failed"
      trackCoreEvent(testEvent, {
        status: result.status,
        statusCode: result.statusCode ?? 0,
        latencyMs: result.latencyMs ?? 0,
      })
      return result
    } catch (error) {
      trackCoreEvent("workflow_test_failed", {
        reason: error instanceof Error ? error.message : "Connection test failed.",
      })
      throw error
    }
  }, [agency, trackCoreEvent, useSupabase, user])

  const runPersistedCheck = useCallback(async (checkId: string) => {
    if (!useSupabase) {
      throw new Error("Saved workflow evidence requires the production data service.")
    }
    const token = await getValidSupabaseAccessToken()
    if (!token) {
      throw new Error("Sign in before running a saved check.")
    }
    const response = await fetch("/api/checks/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ checkId }),
    })
    const result = (await response.json()) as EndpointTestResult & { persisted?: boolean; runId?: string }
    acceptedEndpointApiResult(response.ok, result)
    if (!result.persisted || !result.runId) {
      throw new Error("The check ran, but production evidence was not confirmed.")
    }
    return result
  }, [useSupabase])

  const saveWorkflow = useCallback(
    async (input: WorkflowSetupInput, result: EndpointTestResult) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const currentDatabase = readCoreDatabase()
      const hadWorkflow = currentDatabase.workflows.some((workflow) => workflow.agencyId === agency.id && !workflow.archivedAt)
      const hadCheckRun = currentDatabase.checkRuns.some((run) => run.agencyId === agency.id)
      let recordedResult = result
      let nextDatabase: CoreDatabase

      if (useSupabase) {
        const existingWorkflowIds = new Set(currentDatabase.workflows.map((workflow) => workflow.id))
        const stagedLocalDatabase = createWorkflowReadyForFirstRun(currentDatabase, agency.id, user.id, input)
        const createdWorkflow = stagedLocalDatabase.workflows.find(
          (workflow) => workflow.agencyId === agency.id && !existingWorkflowIds.has(workflow.id)
        )
        const createdCheck = createdWorkflow
          ? stagedLocalDatabase.checks.find(
              (check) => check.agencyId === agency.id && check.workflowId === createdWorkflow.id
            )
          : null
        if (!createdWorkflow || !createdCheck) {
          throw new Error("The workflow could not be staged for its server check. Reload and try again.")
        }
        const stagedDatabase = await persistDatabase(stagedLocalDatabase)
        const exactRecordsPersisted = stagedDatabase.workflows.some((workflow) => workflow.id === createdWorkflow.id)
          && stagedDatabase.checks.some((check) => check.id === createdCheck.id && check.workflowId === createdWorkflow.id)
        if (!exactRecordsPersisted) {
          throw new Error("The workflow was saved, but its exact server check could not be confirmed. Reload and retry the check.")
        }
        recordedResult = await runPersistedCheck(createdCheck.id)
        nextDatabase = await reloadWorkspace()
      } else {
        nextDatabase = await persistDatabase(
          createWorkflowWithFirstRun(currentDatabase, agency.id, user.id, input, result)
        )
      }
      trackCoreEvent("workflow_created", {
        type: input.type,
        environment: input.environment,
        method: input.method,
        reportIncluded: input.reportIncluded,
        firstRunStatus: recordedResult.status,
      })
      if (!hadWorkflow) {
        trackCoreEvent("first_workflow_created", { type: input.type, method: input.method })
        trackCoreEvent("first_check_created", { pluginId: "endpoint" })
      }
      if (!hadCheckRun) {
        trackCoreEvent("first_check_run", { status: recordedResult.status })
      }
      return nextDatabase
    },
    [agency, persistDatabase, reloadWorkspace, runPersistedCheck, trackCoreEvent, useSupabase, user]
  )

  const savePendingWorkflow = useCallback(
    async (input: WorkflowSetupInput & { pendingReason: string }) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(createPendingWorkflow(readCoreDatabase(), agency.id, user.id, input))
      trackCoreEvent("workflow_pending_created", {
        type: input.type,
        environment: input.environment,
        method: input.method,
        reason: input.pendingReason,
      })
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const runCheck = useCallback(
    async (workflowId: string) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const currentDatabase = readCoreDatabase()
      const workflow = currentDatabase.workflows.find((item) => item.agencyId === agency.id && item.id === workflowId)
      if (!workflow) throw new Error("Workflow was not found.")
      const activeChecks = currentDatabase.checks.filter(
        (item) => item.agencyId === agency.id && item.workflowId === workflow.id && item.enabled && !item.pendingSetup
      )
      if (!activeChecks.length) throw new Error("An enabled saved check was not found for this workflow.")
      trackCoreEvent("check_run_started", { checkCount: activeChecks.length })
      const statuses: EndpointTestResult["status"][] = []
      const failures: string[] = []

      if (useSupabase) {
        for (const check of activeChecks) {
          try {
            const result = await runPersistedCheck(check.id)
            statuses.push(result.status)
          } catch (error) {
            failures.push(error instanceof Error ? error.message : `Check ${check.name} failed to run.`)
          }
        }
        const nextDatabase = await reloadWorkspace()
        const outcome = workflowRunOutcome(statuses, failures.length)
        setSyncError(failures.length ? workflowRunFailureMessage(failures, activeChecks.length) : "")
        trackCoreEvent("check_run_completed", { status: outcome, checkCount: activeChecks.length, failureCount: failures.length })
        if (statuses.length && !currentDatabase.checkRuns.some((run) => run.agencyId === agency.id)) {
          trackCoreEvent("first_check_run", { status: outcome })
        }
        return nextDatabase
      }

      const startedAt = new Date().toISOString()
      let nextDatabase = currentDatabase
      for (const check of activeChecks) {
        try {
          const result = await testEndpoint(endpointInputFromSavedCheck({
            configJson: check.configJson,
            assertions: check.assertions,
            endpointUrl: workflow.endpointUrl,
            method: workflow.method,
            encryptedAuthConfig: { headers: workflow.headers },
            requestBody: workflow.requestBody,
            expectedStatus: workflow.expectedStatus,
            timeoutSeconds: workflow.timeoutSeconds,
            maxLatencyMs: workflow.maxLatencyMs,
          }))
          statuses.push(result.status)
          nextDatabase = runWorkflowCheck(
            nextDatabase,
            agency.id,
            user.id,
            workflow.id,
            check.id,
            result,
            "manual_run",
            startedAt
          )
        } catch (error) {
          failures.push(error instanceof Error ? error.message : `Check ${check.name} failed to run.`)
        }
      }
      const persistedDatabase = statuses.length ? await persistDatabase(nextDatabase) : currentDatabase
      const outcome = workflowRunOutcome(statuses, failures.length)
      setSyncError(failures.length ? workflowRunFailureMessage(failures, activeChecks.length) : "")
      trackCoreEvent("check_run_completed", { status: outcome, checkCount: activeChecks.length, failureCount: failures.length })
      if (statuses.length && !currentDatabase.checkRuns.some((run) => run.agencyId === agency.id)) {
        trackCoreEvent("first_check_run", { status: outcome })
      }
      return persistedDatabase
    },
    [agency, persistDatabase, reloadWorkspace, runPersistedCheck, testEndpoint, trackCoreEvent, useSupabase, user]
  )

  const recordRepair = useCallback(
    async (issueId: string, resolutionNote: string) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(recordIssueRepair(readCoreDatabase(), agency.id, user.id, issueId, resolutionNote))
      trackCoreEvent("issue_repair_recorded")
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const runDueChecks = useCallback(async () => {
    if (!user || !agency) throw new Error("Create an agency first.")
    const startedAt = new Date().toISOString()
    const currentDatabase = readCoreDatabase()
    const dueChecks = selectDueChecks(currentDatabase, agency.id, startedAt)
    const attempts = []

    if (dueChecks.length === 0) {
      trackCoreEvent("scheduled_checks_none_due", { checksDue: 0 })
      return currentDatabase
    }

    if (useSupabase) {
      for (const due of dueChecks) {
        try {
          const result = await runPersistedCheck(due.check.id)
          attempts.push({ checkId: due.check.id, workflowId: due.workflow.id, result })
        } catch (error) {
          attempts.push({
            checkId: due.check.id,
            workflowId: due.workflow.id,
            errorMessage: error instanceof Error ? error.message : "Saved check failed.",
          })
        }
      }
      const nextDatabase = await reloadWorkspace()
      trackCoreEvent("scheduled_checks_run", {
        checksDue: dueChecks.length,
        attempts: attempts.length,
      })
      return nextDatabase
    }

    for (const due of dueChecks) {
      try {
        const result = await testEndpoint(endpointInputFromSavedCheck({
          configJson: due.check.configJson,
          assertions: due.check.assertions,
          endpointUrl: due.workflow.endpointUrl,
          method: due.workflow.method,
          encryptedAuthConfig: { headers: due.workflow.headers },
          requestBody: due.workflow.requestBody,
          expectedStatus: due.workflow.expectedStatus,
          timeoutSeconds: due.workflow.timeoutSeconds,
          maxLatencyMs: due.workflow.maxLatencyMs,
        }))
        attempts.push({ checkId: due.check.id, workflowId: due.workflow.id, result })
      } catch (error) {
        attempts.push({
          checkId: due.check.id,
          workflowId: due.workflow.id,
          errorMessage: error instanceof Error ? error.message : "Scheduled check failed.",
        })
      }
    }

    const nextDatabase = await persistDatabase(recordScheduledCheckJob(readCoreDatabase(), agency.id, user.id, {
      startedAt,
      checksDue: dueChecks.length,
      attempts,
    }))
    trackCoreEvent("scheduled_checks_run", {
      checksDue: dueChecks.length,
      attempts: attempts.length,
    })
    return nextDatabase
  }, [agency, persistDatabase, reloadWorkspace, runPersistedCheck, testEndpoint, trackCoreEvent, useSupabase, user])

  const updateIssue = useCallback(
    async (issueId: string, input: Parameters<typeof updateIssueRecord>[4]) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(updateIssueRecord(readCoreDatabase(), agency.id, user.id, issueId, input))
      trackCoreEvent("issue_updated", {
        status: input.status ?? "",
        reportable: typeof input.reportable === "boolean" ? input.reportable : null,
      })
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const createIssueNote = useCallback(
    async (issueId: string, body: string, reportSafe: boolean) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(addIssueNote(readCoreDatabase(), agency.id, user.id, issueId, body, reportSafe))
      trackCoreEvent("issue_note_created", { reportSafe })
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const generateReport = useCallback(
    async (input: { clientId: string; periodStart: string; periodEnd: string }) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const currentDatabase = readCoreDatabase()
      const hadReport = currentDatabase.reports.some((report) => report.agencyId === agency.id)
      const nextDatabase = await persistDatabase(generateReportRecord(currentDatabase, agency, user.id, input))
      trackCoreEvent("report_generated", {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      })
      if (!hadReport) {
        trackCoreEvent("first_report_previewed", {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        })
      }
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const prepareReportDownload = useCallback(
    async (reportId: string) => {
      if (!user || !agency) throw new Error("Create an agency first.")

      if (!useSupabase) {
        const preparedDatabase = createReportDownload(readCoreDatabase(), agency, user.id, reportId)
        const nextDatabase = await persistDatabase(preparedDatabase)
        trackCoreEvent("report_pdf_generated")
        return nextDatabase
      }

      try {
        await prepareReportPdfFromApi(reportId)
        const persistedDatabase = await loadCoreDatabaseFromSupabase(user.id)
        applyDatabase(persistedDatabase)
        setSyncError("")
        trackCoreEvent("report_pdf_generated")
        return persistedDatabase
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : "Could not save report export.")
        try {
          applyDatabase(await loadCoreDatabaseFromSupabase(user.id))
        } catch {
          // Keep the visible sync error if the recovery reload also fails.
        }
        throw error
      }
    },
    [agency, applyDatabase, persistDatabase, trackCoreEvent, useSupabase, user]
  )

  const refreshReport = useCallback(
    async (reportId: string) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(refreshReportRecord(readCoreDatabase(), agency, user.id, reportId))
      trackCoreEvent("report_generated", { action: "snapshot_refreshed" })
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  const saveReportNarrative = useCallback(
    async (reportId: string, narrative: string) => {
      if (!user || !agency) throw new Error("Create an agency first.")
      const nextDatabase = await persistDatabase(updateReportNarrative(readCoreDatabase(), agency, user.id, reportId, narrative))
      trackCoreEvent("report_narrative_updated", { length: narrative.length })
      return nextDatabase
    },
    [agency, persistDatabase, trackCoreEvent, user]
  )

  return {
    user,
    supabaseEnabled: useSupabase,
    database,
    agency,
    data,
    checklist,
    loading: workspaceLoading,
    creatingAgency,
    syncError,
    reloadWorkspace,
    createAgency,
    saveAgency,
    createClient,
    updateClient,
    archiveClient,
    testEndpoint,
    saveWorkflow,
    savePendingWorkflow,
    runCheck,
    runDueChecks,
    recordRepair,
    updateIssue,
    createIssueNote,
    generateReport,
    refreshReport,
    saveReportNarrative,
    prepareReportDownload,
  }
}

function workflowRunOutcome(statuses: EndpointTestResult["status"][], failureCount: number) {
  if (failureCount) return statuses.length ? "partial" : "failed_to_run"
  if (statuses.includes("failed")) return "failed"
  if (statuses.includes("degraded")) return "degraded"
  if (statuses.includes("skipped")) return "inconclusive"
  return "healthy"
}

function workflowRunFailureMessage(failures: string[], checkCount: number) {
  const count = failures.length
  const summary = failures[0] || "A saved check could not be run."
  return `${count} of ${checkCount} workflow checks could not be run. ${summary}`
}
