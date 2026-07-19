import type { Agency, Client, Workflow } from "../core/types.ts"
import type { Journey, JourneyDefinitionDraft, JourneyTemplate, Project, ProjectKind, Workspace } from "./types.ts"

type AgencyEvalColumns = {
  teamTrialStartedAt?: string | null
  teamTrialEndsAt?: string | null
  teamTrialUsedAt?: string | null
  evalRunMonthlyLimitOverride?: number | null
}

type ClientEvalColumns = { projectKind?: ProjectKind }
type WorkflowEvalColumns = {
  journeyTemplate?: JourneyTemplate
  draftDefinition?: JourneyDefinitionDraft
  draftRevision?: number
  activeJourneyVersionId?: string | null
  pausedAt?: string | null
  pauseReason?: string
}

export function workspaceFromAgency(agency: Agency & AgencyEvalColumns): Workspace {
  const { trialEndsAt: _legacyTrialEndsAt, ...legacy } = agency
  void _legacyTrialEndsAt
  return {
    ...legacy,
    teamTrialStartedAt: agency.teamTrialStartedAt ?? null,
    teamTrialEndsAt: agency.teamTrialEndsAt ?? null,
    teamTrialUsedAt: agency.teamTrialUsedAt ?? null,
    evalRunMonthlyLimitOverride: agency.evalRunMonthlyLimitOverride ?? null,
  }
}

export function projectFromClient(client: Client & ClientEvalColumns): Project {
  const { agencyId, ...legacy } = client
  return { ...legacy, workspaceId: agencyId, kind: client.projectKind ?? "client_site" }
}

export function journeyFromWorkflow(workflow: Workflow & WorkflowEvalColumns): Journey {
  const { agencyId, clientId, type: _legacyType, ...legacy } = workflow
  void _legacyType
  const template = workflow.journeyTemplate ?? "legacy_endpoint"
  return {
    ...legacy,
    workspaceId: agencyId,
    projectId: clientId,
    template,
    draftDefinition: workflow.draftDefinition ?? {
      template,
      startUrl: workflow.endpointUrl,
      emailProofConfigured: false,
      cleanupMode: "none",
      stages: [],
    },
    draftRevision: workflow.draftRevision ?? 0,
    activeJourneyVersionId: workflow.activeJourneyVersionId ?? null,
    pausedAt: workflow.pausedAt ?? null,
    pauseReason: workflow.pauseReason ?? "",
  }
}
