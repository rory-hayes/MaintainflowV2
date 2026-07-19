import type { EndpointTestInput, WorkflowMethod } from "./types.ts"
import {
  assertSafeSavedAssertions,
  assertSavedMonitorPolicy,
  savedCheckConfigForExecution,
} from "./saved-monitor-policy.ts"
import { scheduledHeadersFromWorkflowConfig } from "./workflow-auth.ts"

type SavedEndpointCheck = {
  configJson: unknown
  assertions: unknown
  endpointUrl: string
  method: WorkflowMethod
  encryptedAuthConfig: unknown
  requestBody: string
  expectedStatus: number
  timeoutSeconds: number
  maxLatencyMs: number
}

export function endpointInputFromSavedCheck(value: SavedEndpointCheck): EndpointTestInput {
  const config = savedCheckConfigForExecution(value.configJson, {
    endpointUrl: value.endpointUrl,
    method: value.method,
  })
  const savedMonitor = assertSavedMonitorPolicy({
    endpointUrl: value.endpointUrl,
    method: value.method,
    headers: scheduledHeadersFromWorkflowConfig(value.encryptedAuthConfig),
    requestBody: value.requestBody,
  })
  return {
    url: savedMonitor.endpointUrl,
    method: savedMonitor.method,
    headers: savedMonitor.headers,
    body: savedMonitor.requestBody,
    expectedStatus: numberConfig(config.expectedStatus, value.expectedStatus),
    timeoutSeconds: numberConfig(config.timeoutSeconds, value.timeoutSeconds),
    maxLatencyMs: numberConfig(config.maxLatencyMs, value.maxLatencyMs),
    assertions: assertSafeSavedAssertions(value.assertions),
  }
}

function numberConfig(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
