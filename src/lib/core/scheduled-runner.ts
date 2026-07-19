import { getCheckPlugin } from "@/lib/core/plugins/registry"
import type { NormalizedCheckResult } from "@/lib/core/plugins/types"
import type { AssertionConfig, CheckStatus, EndpointTestInput, EndpointTestResult, WorkflowMethod } from "@/lib/core/types"
import { sanitizeAssertionResults } from "@/lib/core/assertions"
import { endpointInputFromSavedCheck } from "@/lib/core/saved-check-config"
import { supabaseServiceJson } from "@/lib/supabase/server"

type ClaimedCheckRow = {
  check_id: string
  agency_id: string
  workflow_id: string
  client_id: string
  plugin_id: string
  config_json: Record<string, unknown> | null
  assertions_json: AssertionConfig[] | null
  schedule_minutes: number
  workflow_name: string
  endpoint_url: string
  method: WorkflowMethod
  encrypted_auth_config: unknown
  request_body: string
  expected_status: number
  timeout_seconds: number
  max_latency_ms: number
  check_updated_at: string
  workflow_updated_at: string
}

type ScheduledCheckResult = {
  status: CheckStatus
  statusCode: number | null
  latencyMs: number | null
  assertionResults: EndpointTestResult["assertionResults"]
  safeResponseSummary: string
  errorMessage: string
  issueFingerprint: string
}

type SchedulerRunSummary = {
  workerId: string
  status: "success" | "partial" | "failed" | "skipped"
  claimed: number
  checksRun: number
  failures: number
  errors: string[]
}

export async function runScheduledChecks(input: { batchSize: number; leaseSeconds: number; workerId?: string }): Promise<SchedulerRunSummary> {
  const workerId = input.workerId ?? `cron-${crypto.randomUUID()}`
  const claimed = await supabaseServiceJson<ClaimedCheckRow[]>("rpc/claim_due_checks", {
    method: "POST",
    body: JSON.stringify({
      // Defense in depth: route callers and direct callers are both limited to
      // one five-check wave per worker invocation.
      max_batch: Math.max(1, Math.min(input.batchSize, 5)),
      lease_seconds: Math.max(120, Math.min(input.leaseSeconds, 900)),
      worker_id: workerId,
    }),
  })
  const startedAt = new Date().toISOString()
  const errors: string[] = []
  const agencyStats = new Map<string, { checksDue: number; checksRun: number; failures: number; errors: string[] }>()
  let checksRun = 0
  let failures = 0

  for (const check of claimed) {
    agencyStats.set(check.agency_id, { checksDue: (agencyStats.get(check.agency_id)?.checksDue ?? 0) + 1, checksRun: 0, failures: 0, errors: [] })
  }

  await Promise.all(claimed.map(async (check) => {
    const stats = agencyStats.get(check.agency_id)
    try {
      const checkStartedAt = new Date().toISOString()
      const result = await runClaimedCheck(check)
      await persistScheduledCheckResult(check, result, checkStartedAt)
      checksRun += 1
      if (stats) {
        stats.checksRun += 1
      }
      if (result.status !== "healthy") {
        failures += 1
        if (stats) {
          stats.failures += 1
        }
        if (result.status === "skipped") {
          const message = `${check.check_id}: Inconclusive check: ${result.errorMessage || result.safeResponseSummary}`
          errors.push(message)
          if (stats) stats.errors.push(message)
        }
      }
    } catch (error) {
      failures += 1
      const message = error instanceof Error ? error.message : "Scheduled check failed."
      errors.push(`${check.check_id}: ${message}`)
      if (stats) {
        stats.failures += 1
        stats.errors.push(`${check.check_id}: ${message}`)
      }
      await releaseCheckLease(check.check_id, check.agency_id, check.check_updated_at)
    }
  }))

  for (const [agencyId, stats] of agencyStats) {
    await insertCheckJobRun({
      id: crypto.randomUUID(),
      status: jobStatus(stats.checksDue, stats.checksRun, stats.failures),
      checks_due: stats.checksDue,
      checks_run: stats.checksRun,
      failures: stats.failures,
      error_message: stats.errors.join(" ").slice(0, 1000),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }, agencyId)
  }

  return {
    workerId,
    status: jobStatus(claimed.length, checksRun, failures),
    claimed: claimed.length,
    checksRun,
    failures,
    errors,
  }
}

async function runClaimedCheck(check: ClaimedCheckRow): Promise<ScheduledCheckResult> {
  const plugin = getCheckPlugin<EndpointTestInput, EndpointTestResult>(check.plugin_id || "endpoint")
  const config = plugin.validateConfig(checkToEndpointInput(check))
  const rawResult = await plugin.run(config)
  const normalized = plugin.normalizeResult(rawResult, config)

  return scheduledResultFromPlugin(rawResult, normalized)
}

function checkToEndpointInput(check: ClaimedCheckRow): EndpointTestInput {
  return endpointInputFromSavedCheck({
    configJson: check.config_json,
    assertions: check.assertions_json,
    endpointUrl: check.endpoint_url,
    method: check.method,
    encryptedAuthConfig: check.encrypted_auth_config,
    requestBody: check.request_body ?? "",
    expectedStatus: check.expected_status,
    timeoutSeconds: check.timeout_seconds,
    maxLatencyMs: check.max_latency_ms,
  })
}

function scheduledResultFromPlugin(rawResult: EndpointTestResult, normalized: NormalizedCheckResult): ScheduledCheckResult {
  return {
    status: normalizedStatus(normalized.status),
    statusCode: rawResult.statusCode,
    latencyMs: rawResult.latencyMs,
    assertionResults: sanitizeAssertionResults(normalized.assertionResults),
    safeResponseSummary: normalized.reportSafeSummary,
    errorMessage: rawResult.errorMessage || (normalized.status === "unhealthy" ? normalized.summary : ""),
    issueFingerprint: normalized.issueFingerprint,
  }
}

async function persistScheduledCheckResult(check: ClaimedCheckRow, result: ScheduledCheckResult, startedAt: string) {
  const runId = crypto.randomUUID()
  const completedAt = new Date().toISOString()
  const rows = await supabaseServiceJson<Array<{ run_id?: string }>>("rpc/record_assurance_check_result", {
    method: "POST",
    body: JSON.stringify({
      p_check_id: check.check_id,
      p_run_id: runId,
      p_status: result.status,
      p_status_code: result.statusCode,
      p_latency_ms: result.latencyMs,
      p_assertion_results_json: result.assertionResults,
      p_safe_response_summary: result.safeResponseSummary.slice(0, 500),
      p_error_message: result.errorMessage.slice(0, 500),
      p_issue_fingerprint: result.issueFingerprint.slice(0, 500),
      p_started_at: startedAt,
      p_completed_at: completedAt,
      p_expected_check_updated_at: check.check_updated_at,
      p_expected_workflow_updated_at: check.workflow_updated_at,
      p_advance_schedule: true,
    }),
  })
  if (!Array.isArray(rows) || rows.length !== 1 || String(rows[0].run_id ?? "") !== runId) {
    throw new Error("Scheduled evidence could not be confirmed after persistence.")
  }
}

async function releaseCheckLease(checkId: string, agencyId: string, expectedUpdatedAt: string) {
  const params = new URLSearchParams({
    id: `eq.${checkId}`,
    agency_id: `eq.${agencyId}`,
    updated_at: `eq.${expectedUpdatedAt}`,
    select: "id",
  })
  await supabaseServiceJson(`checks?${params.toString()}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      lease_expires_at: null,
      leased_by: null,
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => undefined)
}

async function insertCheckJobRun(job: {
  id: string
  status: "success" | "partial" | "failed" | "skipped"
  checks_due: number
  checks_run: number
  failures: number
  error_message: string
  started_at: string
  completed_at: string
  created_at: string
}, agencyId: string | undefined) {
  if (!agencyId) {
    return
  }

  await supabaseServiceJson("check_job_runs", {
    method: "POST",
    body: JSON.stringify({
      ...job,
      agency_id: agencyId,
    }),
  }).catch(() => undefined)
}

function normalizedStatus(status: NormalizedCheckResult["status"]): CheckStatus {
  if (status === "unhealthy") return "failed"
  return status
}

function jobStatus(checksDue: number, attempts: number, failures: number) {
  if (checksDue === 0) return "skipped"
  if (attempts === 0 || attempts === failures) return "failed"
  if (failures > 0 || attempts < checksDue) return "partial"
  return "success"
}
