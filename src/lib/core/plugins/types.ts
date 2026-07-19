import type { EndpointHostnameResolver } from "../endpoint-safety.server.ts"
import type { PinnedEndpointFetch } from "../pinned-http.server.ts"
import type { AssertionResult } from "../types.ts"

export type PluginResultStatus = "healthy" | "degraded" | "unhealthy" | "skipped"

export type CheckPluginRunOptions = {
  fetchImpl?: typeof fetch
  pinnedFetchImpl?: PinnedEndpointFetch
  resolveHostname?: EndpointHostnameResolver
  allowSyntheticDemo?: boolean
}

export type NormalizedCheckResult = {
  status: PluginResultStatus
  durationMs: number | null
  summary: string
  evidence: Record<string, unknown>
  assertionResults: AssertionResult[]
  issueFingerprint: string
  reportSafeSummary: string
}

export type CheckPlugin<Config = unknown, RawResult = unknown> = {
  pluginId: string
  displayName: string
  configSchema: Record<string, unknown>
  validateConfig(input: unknown): Config
  run(config: Config, options?: CheckPluginRunOptions): Promise<RawResult>
  normalizeResult(result: RawResult, config: Config): NormalizedCheckResult
}
