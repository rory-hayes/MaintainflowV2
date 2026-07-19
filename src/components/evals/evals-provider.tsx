"use client"

import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { evalsSeedData } from "./seed-data"
import type {
  EvalRun,
  EvalsData,
  EvalsEndpointHooks,
  EvalsPaginationState,
  Incident,
  IncidentMutation,
  InteractiveEvalRunMode,
  Journey,
  JourneyDraft,
  Project,
} from "./types"

type EvalsContextValue = EvalsData & {
  previewMode: boolean
  workspaceId: string
  activeProjectId: string
  setActiveProjectId: (id: string) => void
  createProject: (draft: PreviewProjectDraft) => Promise<Project>
  updateProject: (id: string, draft: PreviewProjectDraft) => Promise<Project>
  archiveProject: (id: string) => Promise<void>
  authorizeProject: (id: string, approvedActionDomains: string[]) => Promise<Project>
  createJourney: (draft: JourneyDraft) => Promise<Journey>
  updateJourney: (id: string, draft: JourneyDraft) => Promise<Journey>
  runJourney: (id: string, mode?: InteractiveEvalRunMode) => Promise<EvalRun>
  mutateIncident: (id: string, mutation: IncidentMutation) => Promise<Incident | EvalRun>
  cancelRun: (id: string) => Promise<void>
  pauseJourney: (id: string, reason: string) => Promise<Journey>
  resumeJourney: (id: string) => Promise<Journey>
  configureJourneySchedule: (id: string, enabled: boolean, intervalMinutes: number) => Promise<Journey>
  pagination: EvalsPaginationState
  projectFor: (id: string) => Project | undefined
  journeyFor: (id: string) => Journey | undefined
}

type PreviewProjectDraft = {
  name: string
  website: string
  kind: "own_product" | "client_site" | "personal"
  reportRecipientEmail: string
  notes: string
}

const EvalsContext = createContext<EvalsContextValue | null>(null)

export function EvalsProvider({
  children,
  initialData,
  hooks = {},
  mode: providerMode = "production",
  workspaceId = "",
  pagination = emptyPagination,
}: {
  children: ReactNode
  initialData?: EvalsData
  hooks?: EvalsEndpointHooks
  mode?: "production" | "preview"
  workspaceId?: string
  pagination?: EvalsPaginationState
}) {
  const startingData = initialData ?? (providerMode === "preview" ? evalsSeedData : emptyEvalsData)
  const [previewProjects, setPreviewProjects] = useState(startingData.projects)
  const [previewJourneys, setPreviewJourneys] = useState(startingData.journeys)
  const [previewRuns, setPreviewRuns] = useState(startingData.runs)
  const [previewIncidents, setPreviewIncidents] = useState(startingData.incidents)
  const [previewReports] = useState(startingData.reports)
  const projects = providerMode === "production" ? startingData.projects : previewProjects
  const journeys = providerMode === "production" ? startingData.journeys : previewJourneys
  const runs = providerMode === "production" ? startingData.runs : previewRuns
  const incidents = providerMode === "production" ? startingData.incidents : previewIncidents
  const reports = providerMode === "production" ? startingData.reports : previewReports
  const [activeProjectId, setActiveProjectId] = useState(startingData.projects[0]?.id ?? "")

  async function createProject(draft: PreviewProjectDraft) {
    if (providerMode !== "preview") throw unavailableMutationError()
    const website = new URL(draft.website)
    const project: Project = {
      id: `${slugify(draft.name)}-${Date.now().toString().slice(-5)}`,
      name: draft.name.trim(),
      website: website.toString(),
      domain: website.hostname.toLowerCase(),
      description: draft.notes.trim() || `Public customer-journey assurance for ${website.hostname}.`,
      environment: "Production",
      owner: "You",
      ownerEmail: "preview@maintainflow.test",
      journeyIds: [],
      updatedAt: "Just now",
      lastRunAt: "Not run yet",
      kind: draft.kind,
      reportRecipientEmail: draft.reportRecipientEmail.trim(),
      notes: draft.notes.trim(),
      health: "pending",
      activeJourneys: 0,
      openIncidents: 0,
      reportStatus: null,
      legacyEndpointJourneys: 0,
      businessEvalJourneys: 0,
      authorization: null,
    }
    setPreviewProjects((items) => [project, ...items])
    setActiveProjectId(project.id)
    return project
  }

  async function updateProject(id: string, draft: PreviewProjectDraft) {
    if (providerMode !== "preview") throw unavailableMutationError()
    const current = projects.find((project) => project.id === id)
    if (!current) throw new Error("Project not found")
    const website = new URL(draft.website)
    const updated: Project = {
      ...current,
      name: draft.name.trim(),
      website: website.toString(),
      domain: website.hostname.toLowerCase(),
      description: draft.notes.trim() || `Public customer-journey assurance for ${website.hostname}.`,
      kind: draft.kind,
      reportRecipientEmail: draft.reportRecipientEmail.trim(),
      notes: draft.notes.trim(),
      updatedAt: "Just now",
    }
    setPreviewProjects((items) => items.map((project) => project.id === id ? updated : project))
    return updated
  }

  async function archiveProject(id: string) {
    if (providerMode !== "preview") throw unavailableMutationError()
    setPreviewProjects((items) => items.filter((project) => project.id !== id))
    if (activeProjectId === id) setActiveProjectId((projects.find((project) => project.id !== id) ?? null)?.id ?? "")
  }

  async function authorizeProject(id: string, approvedActionDomains: string[]) {
    if (providerMode !== "preview") throw unavailableMutationError()
    const current = projects.find((project) => project.id === id)
    if (!current) throw new Error("Project not found")
    const authorization = {
      id: `preview-auth-${Date.now()}`,
      domain: current.domain,
      approvedActionDomains: [current.domain, ...approvedActionDomains.filter((domain) => domain !== current.domain)],
      attestationVersion: "2026-07-18",
      actor: { userId: "preview-owner", name: "Preview Owner", email: "preview@maintainflow.test" },
      recordedAt: "Just now",
      revokedAt: null,
      state: "current" as const,
    }
    const updated: Project = { ...current, authorization, updatedAt: "Just now" }
    setPreviewProjects((items) => items.map((project) => project.id === id ? updated : project))
    return updated
  }

  async function createJourney(draft: JourneyDraft) {
    if (hooks.createJourney) {
      const created = await hooks.createJourney(draft)
      return created
    }
    if (providerMode !== "preview") throw unavailableMutationError()

    const created: Journey = {
      id: `${slugify(draft.name)}-${Date.now().toString().slice(-5)}`,
      projectId: draft.projectId,
      name: draft.name,
      template: draft.template,
      startUrl: draft.startUrl,
      draftRevision: draft.draftRevision,
      published: true,
      rawDraft: draft,
      source: "business_eval",
      stageEvidenceAvailable: true,
      description: `Public ${draft.template === "lead_form" ? "lead form" : "trial signup"} journey beginning at ${new URL(draft.startUrl).hostname}.`,
      schedule: "Daily",
      scheduleEnabled: false,
      environment: "Production",
      status: "inconclusive",
      owner: "You",
      lastRunAt: "Not run yet",
      cleanupVerified: false,
      stages: draft.stages.map((stage) => ({ id: stage.key, name: stage.name, status: "not_run" as const, expected: stage.expected, observed: "Run the supervised journey to capture evidence.", impact: stage.businessImpact })),
    }
    setPreviewJourneys((current) => [created, ...current])
    return created
  }

  async function updateJourney(id: string, draft: JourneyDraft) {
    if (hooks.updateJourney) {
      const updated = await hooks.updateJourney(id, draft)
      return updated
    }
    if (providerMode !== "preview") throw unavailableMutationError()

    const current = journeys.find((journey) => journey.id === id)
    if (!current) throw new Error("Journey not found")
    const updated: Journey = {
      ...current,
      projectId: draft.projectId,
      name: draft.name,
      template: draft.template,
      startUrl: draft.startUrl,
      draftRevision: draft.draftRevision,
      published: true,
      rawDraft: draft,
      source: "business_eval",
      stageEvidenceAvailable: true,
      cleanupVerified: false,
      stages: draft.stages.map((stage) => ({ id: stage.key, name: stage.name, status: "not_run", expected: stage.expected, observed: "Run the supervised journey to capture evidence.", impact: stage.businessImpact })),
    }
    setPreviewJourneys((items) => items.map((journey) => journey.id === id ? updated : journey))
    return updated
  }

  async function runJourney(id: string, runMode: InteractiveEvalRunMode = "manual") {
    if (hooks.runJourney) {
      const result = await hooks.runJourney(id, runMode)
      return result
    }
    if (providerMode !== "preview") throw unavailableMutationError()

    const journey = journeys.find((item) => item.id === id)
    if (!journey) throw new Error("Journey not found")
    const runId = `run-${Date.now()}`
    const versionId = `${journey.id}-version-${Math.max(1, (journey.draftRevision ?? 0) + 1)}`
    const running: EvalRun = {
      id: runId,
      journeyId: id,
      startedAt: "Just now",
      status: "running",
      duration: "Running",
      impact: "Evaluating",
      triggeredBy: runMode === "debug" ? "Debug capture" : runMode === "supervised" ? "Supervised" : "Manual",
      journeyVersionId: versionId,
      runnerProvider: "local_playwright_fixture",
      cleanupStatus: journey.template === "trial_signup" ? "pending" : "not_required",
      source: "business_eval",
      stageEvidenceAvailable: true,
    }
    setPreviewRuns((current) => [running, ...current])
    await new Promise((resolve) => window.setTimeout(resolve, 900))
    const completedStages = journey.stages.map((stage, position) => {
      const duration = previewStageDuration(stage.id)
      return {
        id: `${runId}-stage-${position + 1}`,
        definitionId: stage.id,
        position,
        status: "passed" as const,
        verdict: "passed" as const,
        expected: stage.expected,
        observed: previewPassingObservation(stage.id, stage.name),
        errorCode: "",
        diagnostics: { deterministic: true, fixture: true },
        assertions: [{ kind: "deterministic", passed: true }],
        evidenceArtifactIds: [],
        startedAt: "Just now",
        completedAt: "Just now",
        duration,
      }
    })
    const result: EvalRun = {
      ...running,
      status: "passed",
      duration: "1m 09s",
      impact: "None",
      completedAt: "Just now",
      summary: "Every enabled stage and required cleanup passed deterministically in the local controlled fixture.",
      cleanupStatus: journey?.template === "trial_signup" ? "passed" : "not_required",
      stageEvidence: completedStages,
      evidenceArtifacts: [],
    }
    setPreviewRuns((current) => current.map((run) => run.id === result.id ? result : run))
    setPreviewJourneys((current) => current.map((journey) => journey.id === id
      ? {
          ...journey,
          status: "passed",
          lastRunAt: "Just now",
          supervisedRunId: runMode === "supervised" ? result.id : journey.supervisedRunId,
          cleanupVerified: journey.template === "trial_signup" ? true : journey.cleanupVerified,
          stages: journey.stages.map((stage) => ({
            ...stage,
            status: "passed" as const,
            duration: previewStageDuration(stage.id),
            observed: previewPassingObservation(stage.id, stage.name),
          })),
        }
      : journey))
    return result
  }

  async function mutateIncident(id: string, mutation: IncidentMutation) {
    if (hooks.mutateIncident) {
      const updated = await hooks.mutateIncident(id, mutation)
      return updated
    }
    if (providerMode !== "preview") throw unavailableMutationError()

    const current = incidents.find((incident) => incident.id === id)
    if (!current) throw new Error("Incident not found")
    if (mutation.action === "verify") {
      const verificationRun = await runJourney(current.journeyId, "manual")
      if (verificationRun.status === "passed") {
        setPreviewIncidents((items) => items.map((incident) => incident.id === id
          ? {
              ...incident,
              status: "resolved",
              resolvedAt: "Just now",
              verificationEvalRunId: verificationRun.id,
            }
          : incident))
      }
      return verificationRun
    }
    const updated: Incident = {
      ...current,
      status: mutation.action === "snooze" ? "snoozed" : mutation.action === "record_repair" ? "in_review" : current.status,
      ownerUserId: mutation.action === "assign" ? mutation.ownerUserId : current.ownerUserId,
      repairNote: mutation.action === "record_repair" ? mutation.note : current.repairNote,
    }
    setPreviewIncidents((items) => items.map((incident) => incident.id === id ? updated : incident))
    return updated
  }

  async function cancelRun(id: string) {
    if (hooks.cancelRun) {
      await hooks.cancelRun(id)
      return
    }
    if (providerMode !== "preview") throw unavailableMutationError()
    setPreviewRuns((current) => current.map((run) => run.id === id && (run.status === "queued" || run.status === "running")
      ? { ...run, status: "cancelled", completedAt: "Just now", cancelRequestedAt: "Just now" }
      : run))
  }

  async function pauseJourney(id: string, reason: string) {
    if (hooks.pauseJourney) return hooks.pauseJourney(id, reason)
    if (providerMode !== "preview") throw unavailableMutationError()
    const current = journeys.find((journey) => journey.id === id)
    if (!current) throw new Error("Journey not found")
    const updated = { ...current, pausedAt: "Just now", pauseReason: reason, scheduleEnabled: false, schedule: "Not scheduled" }
    setPreviewJourneys((items) => items.map((journey) => journey.id === id ? updated : journey))
    return updated
  }

  async function resumeJourney(id: string) {
    if (hooks.resumeJourney) return hooks.resumeJourney(id)
    if (providerMode !== "preview") throw unavailableMutationError()
    const current = journeys.find((journey) => journey.id === id)
    if (!current) throw new Error("Journey not found")
    const updated = { ...current, pausedAt: null, pauseReason: "" }
    setPreviewJourneys((items) => items.map((journey) => journey.id === id ? updated : journey))
    return updated
  }

  async function configureJourneySchedule(id: string, enabled: boolean, intervalMinutes: number) {
    if (hooks.configureJourneySchedule) return hooks.configureJourneySchedule(id, enabled, intervalMinutes)
    if (providerMode !== "preview") throw unavailableMutationError()
    const current = journeys.find((journey) => journey.id === id)
    if (!current) throw new Error("Journey not found")
    const updated = {
      ...current,
      scheduleEnabled: enabled,
      schedule: enabled ? intervalMinutes === 1_440 ? "Daily" : `Every ${intervalMinutes} minutes` : "Not scheduled",
    }
    setPreviewJourneys((items) => items.map((journey) => journey.id === id ? updated : journey))
    return updated
  }

  const value = useMemo<EvalsContextValue>(() => ({
    projects,
    journeys,
    runs,
    incidents,
    reports,
    previewMode: providerMode === "preview",
    workspaceId,
    activeProjectId,
    setActiveProjectId,
    createProject,
    updateProject,
    archiveProject,
    authorizeProject,
    createJourney,
    updateJourney,
    runJourney,
    mutateIncident,
    cancelRun,
    pauseJourney,
    resumeJourney,
    configureJourneySchedule,
    pagination,
    projectFor: (id) => projects.find((project) => project.id === id),
    journeyFor: (id) => journeys.find((journey) => journey.id === id),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activeProjectId, incidents, journeys, pagination, projects, providerMode, reports, runs, workspaceId])

  return <EvalsContext.Provider value={value}>{children}</EvalsContext.Provider>
}

const emptyEvalsData: EvalsData = { projects: [], journeys: [], runs: [], incidents: [], reports: [] }

const emptyPage = { hasMore: false, loadingMore: false, loadMore: async () => undefined }
const emptyPagination: EvalsPaginationState = {
  projects: emptyPage,
  journeys: emptyPage,
  runs: emptyPage,
  incidents: emptyPage,
  reports: emptyPage,
}

function unavailableMutationError() {
  return new Error("This action is unavailable because the production eval service is not connected.")
}

function previewPassingObservation(stageId: string, stageName: string) {
  const identity = `${stageId} ${stageName}`
  if (/cleanup|delete|remove/i.test(identity)) return "The synthetic account was removed and the deterministic cleanup confirmation was visible."
  if (/verification[_ -]?opened|open.*verification|link/i.test(identity)) return "One allowlisted verification link opened and reached the approved public destination."
  if (/verification[_ -]?received|email/i.test(identity)) return "The uniquely matched proof email arrived in 1m 24s, within the configured threshold."
  if (/workspace|account[_ -]?state/i.test(identity)) return "The expected account and workspace state was visible after verification."
  if (/success|confirmation|thank/i.test(identity)) return "The configured browser success state appeared once after submission."
  if (/submit/i.test(identity)) return "The marked synthetic values were accepted by the single approved submit action."
  if (/page|opened|load|form/i.test(identity)) return "The approved public page loaded and the configured form was visible."
  if (/endpoint/i.test(identity)) return "The approved endpoint returned the configured deterministic healthy response."
  return "Every configured deterministic assertion for this stage passed."
}

function previewStageDuration(stageId: string) {
  if (/cleanup|delete/i.test(stageId)) return "890 ms"
  if (/verification[_ -]?opened|link/i.test(stageId)) return "1.1 s"
  if (/verification[_ -]?received|email/i.test(stageId)) return "1m 24s"
  if (/workspace|account/i.test(stageId)) return "720 ms"
  if (/submit/i.test(stageId)) return "842 ms"
  return "418 ms"
}

export function useEvals() {
  const value = useContext(EvalsContext)
  if (!value) throw new Error("useEvals must be used inside EvalsProvider")
  return value
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey"
}
