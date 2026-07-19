import type { RestrictedAction } from "@/lib/api/business-evals-contracts"

export type RunnerProviderName = "browserbase" | "local_playwright"
export type RunnerStageVerdict = "passed" | "degraded" | "failed" | "inconclusive" | "cancelled" | "not_run"

export type RunnerAssertionResult = {
  assertionId: string
  required: boolean
  expectedRule: string
  safeObservation: string
  observationDigest: string
  result: RunnerStageVerdict
  evaluatedAt: string
  evaluatorVersion: string
}

export type BrowserSessionHandle = {
  provider: RunnerProviderName
  sessionId: string
  allowedHosts: string[]
  expiresAt: string
}

export type BrowserEvalStage = {
  id: string
  key: string
  name: string
  position: number
  required: boolean
  cleanup: boolean
  expected: string
  businessImpact: string
  timingThresholdMs?: number | null
  actions: RestrictedAction[]
}

export type SyntheticRunValues = Record<string, string>
export type RunnerTraceMode = "diagnostic"

export type RunnerArtifact = {
  kind: "screenshot" | "trace" | "dom_summary" | "network_summary"
  stageId: string
  contentType: string
  dataBase64: string
  reportSafe: boolean
  redacted: boolean
}

export type RunnerStageResult = {
  stageId: string
  verdict: RunnerStageVerdict
  startedAt: string
  completedAt: string
  durationMs: number
  expected: string
  observed: string
  errorCode: string | null
  diagnostics: Record<string, string | number | boolean | null>
  assertionResults: RunnerAssertionResult[]
}

export type BrowserPhaseResult = {
  session: BrowserSessionHandle
  stages: RunnerStageResult[]
  artifacts: RunnerArtifact[]
  currentUrl: string
  captchaDetected: boolean
  sideEffectCompletedAt: string | null
}

export type ExecuteBrowserPhaseInput = {
  session?: BrowserSessionHandle
  runId: string
  traceMode: RunnerTraceMode
  startUrl: string
  allowedHosts: string[]
  stages: BrowserEvalStage[]
  values: SyntheticRunValues
  /** Rechecked immediately before an action or request that may have a side effect. */
  assertExecutionAllowed?: () => Promise<void>
  /** Consumes the persistent safety budget for each distinct actual destination host. */
  consumeDestination?: (url: URL) => Promise<void>
}

export interface BrowserEvalProvider {
  readonly name: RunnerProviderName
  executePhase(input: ExecuteBrowserPhaseInput): Promise<BrowserPhaseResult>
  releaseSession(session: BrowserSessionHandle): Promise<void>
}
