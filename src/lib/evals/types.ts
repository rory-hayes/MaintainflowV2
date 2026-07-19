import type { Agency, Client, Workflow } from "../core/types.ts"

export const journeyTemplates = ["lead_form", "trial_signup", "legacy_endpoint"] as const
export type JourneyTemplate = (typeof journeyTemplates)[number]

export const evalVerdicts = [
  "passed",
  "degraded",
  "failed",
  "inconclusive",
  "cancelled",
  "not_run",
] as const
export type EvalVerdict = (typeof evalVerdicts)[number]

export type ProjectKind = "own_product" | "client_site" | "personal"

export type Workspace = Omit<Agency, "trialEndsAt"> & {
  teamTrialStartedAt: string | null
  teamTrialEndsAt: string | null
  teamTrialUsedAt: string | null
  evalRunMonthlyLimitOverride: number | null
}

export type Project = Omit<Client, "agencyId"> & {
  workspaceId: string
  kind: ProjectKind
}

export type Journey = Omit<Workflow, "agencyId" | "clientId" | "type"> & {
  workspaceId: string
  projectId: string
  template: JourneyTemplate
  draftDefinition: JourneyDefinitionDraft
  draftRevision: number
  activeJourneyVersionId: string | null
  pausedAt: string | null
  pauseReason: string
}

export type JourneyDefinitionDraft = {
  template: JourneyTemplate
  startUrl: string
  emailProofConfigured: boolean
  cleanupMode: "none" | "in_product" | "webhook"
  stages: JourneyStageDraft[]
}

export type JourneyStageDraft = {
  key: string
  name: string
  position: number
  required: boolean
  cleanup: boolean
  actions: JourneyAction[]
  expected: string
  businessImpact: string
  timingThresholdMs: number | null
}

export type LocatorDefinition =
  | { kind: "role"; role: string; name: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string; exact?: boolean }
  | { kind: "test_id"; value: string }

export type TargetReference = LocatorDefinition

export type VerificationLinkRule = {
  host: string
  pathPrefix: string
  requiredText?: string
  requiredQueryParameter?: string
}

type JourneyActionBase = {
  id: string
  label: string
  timeoutMs: number
}

export type JourneyAction = JourneyActionBase & (
  | { type: "navigate"; url: string }
  | { type: "fill"; operation: "text"; locator: LocatorDefinition; valueKey: string }
  | { type: "fill"; operation: "select"; locator: LocatorDefinition; optionValue: string }
  | {
      type: "fill"
      operation: "check"
      locator: LocatorDefinition
      expectedChecked: true
      operatorApproved: true
      controlKind: "checkbox"
    }
  | {
      type: "fill"
      operation: "check"
      locator: LocatorDefinition
      expectedChecked: true
      operatorApproved: true
      controlKind: "radio"
      radioGroup: string
    }
  | { type: "click"; locator: LocatorDefinition }
  | { type: "wait_for_url"; urlPattern: string }
  | { type: "wait_for_text"; text: string }
  | {
      type: "wait_for_email"
      recipientKey: "email" | "forwarding"
      proofMode: "autoresponse" | "forwarded_marker"
      thresholdSeconds: number
      maximumWaitSeconds: number
    }
  | { type: "open_email_link"; allowedHosts: string[]; linkRule: VerificationLinkRule }
  | { type: "assert_visible"; locator: LocatorDefinition }
  | { type: "cleanup"; mode: "in_product"; locator: LocatorDefinition }
  | { type: "cleanup"; mode: "webhook"; webhookUrl: string }
)

export type ActionManifest = {
  actions: JourneyAction[]
}

export type StageResult = {
  stageId: string
  verdict: EvalVerdict
  status?: "completed" | "cancelled" | "not_run"
  observedText?: string
  errorCode?: string
  diagnostics?: Record<string, unknown>
  assertionResults?: Array<Record<string, unknown>>
  evidenceArtifactIds?: string[]
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export type EvalCleanupStatus = "pending" | "passed" | "failed" | "not_required" | "skipped"

export type EvalSchedulePolicy = {
  intervalMinutes: number
  enabled: boolean
  cleanupRequired: boolean
}
