import "server-only"

import { sanitizeAssertionResults } from "@/lib/core/assertions"
import { runEndpointTest } from "@/lib/core/check-runner"
import { preserveValidDatabaseTimestamp } from "@/lib/core/database-timestamp"
import { normalizeEndpointResult } from "@/lib/core/plugins/endpoint-result"
import { endpointInputFromSavedCheck } from "@/lib/core/saved-check-config"
import type { EndpointTestResult, WorkflowMethod } from "@/lib/core/types"
import { getSupabaseUserAuthConfig, type SupabaseUserAuthConfig } from "@/lib/supabase/user-auth"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

type PersistedCheckDependencies = {
  config?: SupabaseUserAuthConfig
  fetchImpl?: typeof fetch
  runEndpoint?: typeof runEndpointTest
  serviceJson?: typeof supabaseServiceJson
  now?: () => string
  randomUUID?: () => string
}

export type PersistedEndpointTestResult = EndpointTestResult & {
  persisted: true
  runId: string
  checkId: string
  workflowId: string
  agencyId: string
}

export class PersistedCheckError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "PersistedCheckError"
    this.status = status
  }
}

export async function runAndPersistAuthorizedCheck(
  token: string,
  checkId: string,
  dependencies: PersistedCheckDependencies = {}
): Promise<PersistedEndpointTestResult> {
  if (!isUuid(checkId)) {
    throw new PersistedCheckError(400, "A valid saved check is required.")
  }

  const config = dependencies.config ?? getSupabaseUserAuthConfig()
  if (!config.enabled) {
    throw new PersistedCheckError(503, "Saved workflow checks are not configured.")
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch
  const checkRows = await supabaseUserRows(
    config,
    token,
    `checks?${query({
      select: "id,agency_id,workflow_id,plugin_id,enabled,pending_setup,config_json,assertions_json,schedule_minutes,updated_at",
      id: `eq.${checkId}`,
      limit: "1",
    })}`,
    fetchImpl
  )
  const check = checkRows[0]
  if (!check) {
    throw new PersistedCheckError(404, "Saved check was not found for this user.")
  }
  const agencyId = String(check.agency_id ?? "")
  const workflowId = String(check.workflow_id ?? "")
  const workflowRows = await supabaseUserRows(
    config,
    token,
    `workflows?${query({
      select: "id,agency_id,client_id,name,endpoint_url,method,encrypted_auth_config,request_body,expected_status,timeout_seconds,max_latency_ms,frequency_minutes,archived_at,updated_at",
      id: `eq.${workflowId}`,
      agency_id: `eq.${agencyId}`,
      limit: "1",
    })}`,
    fetchImpl
  )
  const workflow = workflowRows[0]
  if (!workflow) {
    throw new PersistedCheckError(404, "Saved workflow was not found for this check.")
  }
  if (workflow.archived_at) {
    throw new PersistedCheckError(409, "Archived workflows cannot be tested.")
  }
  if (!check.enabled || check.pending_setup) {
    throw new PersistedCheckError(409, "Complete the saved check setup before recording evidence.")
  }
  if (String(check.plugin_id ?? "endpoint") !== "endpoint") {
    throw new PersistedCheckError(409, "This saved check type is not supported by the endpoint runner.")
  }

  const startedAt = (dependencies.now ?? (() => new Date().toISOString()))()
  const endpointInput = endpointInputFromSavedCheck({
    configJson: check.config_json,
    assertions: check.assertions_json,
    endpointUrl: String(workflow.endpoint_url ?? ""),
    method: String(workflow.method ?? "GET").toUpperCase() as WorkflowMethod,
    encryptedAuthConfig: workflow.encrypted_auth_config,
    requestBody: String(workflow.request_body ?? ""),
    expectedStatus: numberValue(workflow.expected_status, 200),
    timeoutSeconds: numberValue(workflow.timeout_seconds, 10),
    maxLatencyMs: numberValue(workflow.max_latency_ms, 5_000),
  })
  const result = await (dependencies.runEndpoint ?? runEndpointTest)(endpointInput)
  const completedAt = (dependencies.now ?? (() => new Date().toISOString()))()
  const normalized = normalizeEndpointResult(result, endpointInput)
  const assertionResults = sanitizeAssertionResults(result.assertionResults)
  const runId = (dependencies.randomUUID ?? crypto.randomUUID)()
  const serviceJson = dependencies.serviceJson ?? supabaseServiceJson
  let rpcResult: Array<{ run_id?: string }>
  try {
    rpcResult = await serviceJson<Array<{ run_id?: string }>>("rpc/record_assurance_check_result", {
      method: "POST",
      body: JSON.stringify({
        p_check_id: String(check.id),
        p_run_id: runId,
        p_status: result.status,
        p_status_code: result.statusCode,
        p_latency_ms: result.latencyMs,
        p_assertion_results_json: assertionResults,
        p_safe_response_summary: limitedText(result.safeResponseSummary, 500),
        p_error_message: limitedText(result.errorMessage, 500),
        p_issue_fingerprint: limitedText(normalized.issueFingerprint, 500),
        p_started_at: startedAt,
        p_completed_at: completedAt,
        p_expected_check_updated_at: requiredTimestamp(check.updated_at),
        p_expected_workflow_updated_at: requiredTimestamp(workflow.updated_at),
        p_advance_schedule: true,
      }),
    })
  } catch {
    throw new PersistedCheckError(
      409,
      "The saved check changed or its evidence could not be committed. Reload and retry."
    )
  }
  const persistedRow = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult
  if (!persistedRow || String(persistedRow.run_id ?? "") !== runId) {
    throw new PersistedCheckError(502, "The check ran, but its evidence could not be confirmed.")
  }

  return {
    ...result,
    assertionResults,
    persisted: true,
    runId,
    checkId,
    workflowId,
    agencyId,
  }
}

async function supabaseUserRows(
  config: SupabaseUserAuthConfig,
  token: string,
  path: string,
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => [])) as Row[]
  if (!response.ok) {
    throw new PersistedCheckError(response.status || 502, "Saved check configuration could not be loaded.")
  }
  return Array.isArray(payload) ? payload : []
}

function numberValue(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function requiredTimestamp(value: unknown) {
  const timestamp = preserveValidDatabaseTimestamp(value)
  if (!timestamp) {
    throw new PersistedCheckError(409, "Saved check configuration is missing its concurrency version.")
  }
  return timestamp
}

function limitedText(value: unknown, maxLength: number) {
  return String(value ?? "").slice(0, maxLength)
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
