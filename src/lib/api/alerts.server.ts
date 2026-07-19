import "server-only"

import { validateEndpointUrlForRequest } from "@/lib/core/endpoint-safety.server"
import { getEffectiveBillingPlan, resolveBillingEntitlement } from "@/lib/billing/entitlements"
import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import {
  alertEncryptionAssociatedData,
  createAlertSigningSecret,
  decryptAlertValue,
  encryptAlertValue,
} from "@/lib/api/alerts-crypto"
import { alertTargetPreview, normalizeAlertEmail, safeAlertText } from "@/lib/api/alerts-shared"
import { nextWebhookAttemptAt } from "@/lib/alerts/outbound-webhook"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>
type AlertEndpointKind = "email" | "webhook"
type AlertEventType = "eval_run.completed" | "incident.opened" | "incident.recovered"

const ENDPOINT_SELECT = "id,display_name,endpoint_type,target_preview,enabled,created_by_user_id,created_at,updated_at"

export async function listAlertSettings(agencyId: string) {
  const [endpoints, deliveries, entitlement] = await Promise.all([
    supabaseServiceJson<Row[]>(`alert_endpoints?${query({
      select: ENDPOINT_SELECT,
      agency_id: `eq.${agencyId}`,
      order: "created_at.asc",
    })}`),
    supabaseServiceJson<Row[]>(`alert_deliveries?${query({
      select: "id,alert_endpoint_id,eval_run_id,issue_id,event_type,status,attempt_count,next_attempt_at,delivered_at,last_error_safe,created_at,updated_at",
      agency_id: `eq.${agencyId}`,
      order: "created_at.desc",
      limit: "50",
    })}`),
    loadAlertEntitlement(agencyId),
  ])
  return {
    endpoints: endpoints.map(presentEndpoint),
    deliveries: deliveries.map(presentDelivery),
    entitlement: {
      email: entitlement.plan.features.email,
      webhook: entitlement.plan.features.webhook,
      state: entitlement.state,
      plan: entitlement.plan.name,
    },
  }
}

export async function createAlertEndpoint(input: {
  agencyId: string
  userId: string
  kind: AlertEndpointKind
  name: string
  destination: string
  enabled: boolean
}) {
  await requireAlertFeature(input.agencyId, input.kind)
  const destination = await normalizeAlertDestination(input.kind, input.destination)
  const endpointId = crypto.randomUUID()
  const encryptionSecret = requireAlertEncryptionSecret()
  const signingSecret = input.kind === "webhook" ? createAlertSigningSecret() : ""
  const rows = await supabaseServiceJson<Row[]>("alert_endpoints", {
    method: "POST",
    body: JSON.stringify({
      id: endpointId,
      agency_id: input.agencyId,
      display_name: input.name,
      endpoint_type: input.kind,
      target_ciphertext: encryptAlertValue(
        destination,
        encryptionSecret,
        alertEncryptionAssociatedData({ agencyId: input.agencyId, endpointId, field: "target" })
      ),
      target_preview: alertTargetPreview(input.kind, destination),
      signing_secret_ciphertext: signingSecret
        ? encryptAlertValue(
            signingSecret,
            encryptionSecret,
            alertEncryptionAssociatedData({ agencyId: input.agencyId, endpointId, field: "signing-secret" })
          )
        : "",
      enabled: input.enabled,
      created_by_user_id: input.userId,
    }),
  })
  if (!rows[0]) throw new Error("Supabase did not return the new alert endpoint.")
  return {
    endpoint: presentEndpoint(rows[0]),
    // Webhook signing secrets are returned exactly once and are never exposed by list/read APIs.
    signingSecret: signingSecret || null,
  }
}

export async function updateAlertEndpoint(input: {
  agencyId: string
  endpointId: string
  name?: string
  destination?: string
  enabled?: boolean
  rotateSigningSecret?: boolean
}) {
  const endpoint = await loadStoredEndpoint(input.agencyId, input.endpointId)
  const kind = endpoint.endpoint_type as AlertEndpointKind
  if (input.enabled === true || input.destination !== undefined || input.rotateSigningSecret) {
    await requireAlertFeature(input.agencyId, kind)
  }

  const patch: Row = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) patch.display_name = input.name
  if (input.enabled !== undefined) patch.enabled = input.enabled
  const encryptionSecret = input.destination !== undefined || input.rotateSigningSecret
    ? requireAlertEncryptionSecret()
    : ""
  if (input.destination !== undefined) {
    const destination = await normalizeAlertDestination(kind, input.destination)
    patch.target_ciphertext = encryptAlertValue(
      destination,
      encryptionSecret,
      alertEncryptionAssociatedData({ agencyId: input.agencyId, endpointId: input.endpointId, field: "target" })
    )
    patch.target_preview = alertTargetPreview(kind, destination)
  }
  let signingSecret: string | null = null
  if (input.rotateSigningSecret) {
    if (kind !== "webhook") {
      throw new BusinessEvalsApiError(400, "WEBHOOK_REQUIRED", "Only webhook destinations have signing secrets.")
    }
    signingSecret = createAlertSigningSecret()
    patch.signing_secret_ciphertext = encryptAlertValue(
      signingSecret,
      encryptionSecret,
      alertEncryptionAssociatedData({ agencyId: input.agencyId, endpointId: input.endpointId, field: "signing-secret" })
    )
  }

  const rows = await supabaseServiceJson<Row[]>(`alert_endpoints?${query({
    id: `eq.${input.endpointId}`,
    agency_id: `eq.${input.agencyId}`,
    select: ENDPOINT_SELECT,
  })}`, { method: "PATCH", body: JSON.stringify(patch) })
  if (!rows[0]) throw new BusinessEvalsApiError(404, "ALERT_ENDPOINT_NOT_FOUND", "Alert destination not found.")
  return { endpoint: presentEndpoint(rows[0]), signingSecret }
}

export async function deleteAlertEndpoint(agencyId: string, endpointId: string) {
  await loadStoredEndpoint(agencyId, endpointId)
  const deliveries = await supabaseServiceJson<Row[]>(`alert_deliveries?${query({
    select: "id",
    agency_id: `eq.${agencyId}`,
    alert_endpoint_id: `eq.${endpointId}`,
    limit: "1",
  })}`)
  if (deliveries[0]) {
    await supabaseServiceJson(`alert_endpoints?${query({ id: `eq.${endpointId}`, agency_id: `eq.${agencyId}` })}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() }),
    })
    return { deleted: false, disabled: true, reason: "Delivery history was preserved." }
  }
  await supabaseServiceJson(`alert_endpoints?${query({ id: `eq.${endpointId}`, agency_id: `eq.${agencyId}` })}`, {
    method: "DELETE",
    prefer: "return=minimal",
  })
  return { deleted: true, disabled: false }
}

export async function queueAlertDeliveries(input: {
  agencyId: string
  eventType: AlertEventType
  evalRunId?: string
  issueId?: string
}) {
  if (Boolean(input.evalRunId) === Boolean(input.issueId)) {
    throw new Error("An alert delivery must reference exactly one eval run or incident.")
  }
  const entitlement = await loadAlertEntitlement(input.agencyId)
  if (!entitlement.entitlement.grantsPaidAccess) return { queued: 0, skipped: "paid_plan_required" as const }
  const endpoints = await supabaseServiceJson<Row[]>(`alert_endpoints?${query({
    select: "id,endpoint_type",
    agency_id: `eq.${input.agencyId}`,
    enabled: "eq.true",
    order: "created_at.asc",
  })}`)
  let queued = 0
  const now = new Date().toISOString()
  for (const endpoint of endpoints) {
    const kind = endpoint.endpoint_type as AlertEndpointKind
    if (!entitlement.plan.features[kind]) continue
    const sourceId = input.evalRunId ?? input.issueId ?? ""
    const rowId = crypto.randomUUID()
    const rows = await supabaseServiceJson<Row[]>(`alert_deliveries?on_conflict=agency_id,idempotency_key`, {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: JSON.stringify({
        id: rowId,
        agency_id: input.agencyId,
        alert_endpoint_id: endpoint.id,
        eval_run_id: input.evalRunId ?? null,
        issue_id: input.issueId ?? null,
        event_type: input.eventType,
        idempotency_key: `${input.eventType}:${sourceId}:${endpoint.id}`,
        status: "pending",
        attempt_count: 0,
        next_attempt_at: now,
      }),
    })
    if (rows[0]) queued += 1
  }
  return { queued, skipped: null }
}

/**
 * Durable post-finalization entry point. Call this from its own Workflow step
 * after `finalize_business_eval_run` commits. A transient failure should retry
 * this step; it must never be folded into the verdict transaction. Delivery
 * idempotency makes the whole step safe to replay.
 */
export async function queueFinalizedEvalAlerts(input: {
  agencyId: string
  evalRunId: string
  incidentId?: string | null
}) {
  const outboxRows = await supabaseServiceJson<Row[]>(`eval_alert_outbox?${query({
    select: "id,agency_id,eval_run_id,issue_id,status,attempt_count,next_attempt_at,processed_at,updated_at",
    agency_id: `eq.${input.agencyId}`,
    eval_run_id: `eq.${input.evalRunId}`,
    limit: "1",
  })}`)
  const outbox = outboxRows[0]
  if (!outbox) throw new Error("The finalized eval is missing its transactional alert outbox intent.")
  if (String(outbox.status) === "processed") return { processed: true, replayed: true }
  if (input.incidentId && outbox.issue_id && String(outbox.issue_id) !== input.incidentId) {
    throw new Error("The finalized incident does not match its transactional alert outbox intent.")
  }

  const attempt = Number(outbox.attempt_count ?? 0) + 1
  const startedAt = new Date()
  const claimed = await supabaseServiceJson<Row[]>(`eval_alert_outbox?${query({
    id: `eq.${String(outbox.id)}`,
    agency_id: `eq.${input.agencyId}`,
    status: `eq.${String(outbox.status)}`,
    attempt_count: `eq.${Number(outbox.attempt_count ?? 0)}`,
    updated_at: `eq.${String(outbox.updated_at)}`,
    select: "id",
  })}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "processing",
      attempt_count: attempt,
      next_attempt_at: null,
      last_error_safe: "",
      updated_at: startedAt.toISOString(),
    }),
  })
  if (!claimed[0]) return { processed: false, replayed: true, contended: true }

  try {
    const evalRun = await queueAlertDeliveries({
      agencyId: input.agencyId,
      eventType: "eval_run.completed",
      evalRunId: input.evalRunId,
    })
    let incident: Awaited<ReturnType<typeof queueAlertDeliveries>> | null = null
    if (outbox.issue_id) {
      const rows = await supabaseServiceJson<Row[]>(`issues?${query({
        select: "id,status",
        agency_id: `eq.${input.agencyId}`,
        id: `eq.${String(outbox.issue_id)}`,
        limit: "1",
      })}`)
      if (!rows[0]) throw new Error("The finalized eval incident was not found for alert queueing.")
      incident = await queueAlertDeliveries({
        agencyId: input.agencyId,
        eventType: String(rows[0].status) === "resolved" ? "incident.recovered" : "incident.opened",
        issueId: String(outbox.issue_id),
      })
    }
    const processedAt = new Date().toISOString()
    await patchAlertOutbox(input.agencyId, String(outbox.id), attempt, {
      status: "processed",
      processed_at: processedAt,
      next_attempt_at: null,
      last_error_safe: "",
      updated_at: processedAt,
    })
    return { processed: true, replayed: false, evalRun, incident }
  } catch (error) {
    await patchAlertOutbox(input.agencyId, String(outbox.id), attempt, {
      status: "failed",
      processed_at: null,
      next_attempt_at: nextWebhookAttemptAt(attempt, startedAt.getTime()),
      last_error_safe: safeAlertText(error instanceof Error ? error.message : "Alert fanout failed.", "Alert fanout failed.", 300),
      updated_at: new Date().toISOString(),
    })
    throw error
  }
}

async function patchAlertOutbox(
  agencyId: string,
  outboxId: string,
  expectedAttempt: number,
  patch: Record<string, unknown>
) {
  await supabaseServiceJson(`eval_alert_outbox?${query({
    id: `eq.${outboxId}`,
    agency_id: `eq.${agencyId}`,
    status: "eq.processing",
    attempt_count: `eq.${expectedAttempt}`,
  })}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify(patch),
  })
}

export async function loadAlertEntitlement(agencyId: string) {
  const rows = await supabaseServiceJson<Row[]>(`agencies?${query({
    select: "plan,trial_ends_at,team_trial_ends_at,billing_contract_version,stripe_customer_id,stripe_subscription_id,stripe_subscription_status,complimentary_entitlement,complimentary_entitlement_reason",
    id: `eq.${agencyId}`,
    limit: "1",
  })}`)
  const agency = rows[0]
  if (!agency) throw new BusinessEvalsApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.")
  const billingInput = {
    plan: agency.plan,
    trialEndsAt: agency.trial_ends_at,
    teamTrialEndsAt: agency.team_trial_ends_at,
    billingContractVersion: agency.billing_contract_version,
    stripeCustomerId: agency.stripe_customer_id,
    stripeSubscriptionId: agency.stripe_subscription_id,
    stripeSubscriptionStatus: agency.stripe_subscription_status,
    complimentaryEntitlement: agency.complimentary_entitlement,
    complimentaryEntitlementReason: agency.complimentary_entitlement_reason,
  } as Parameters<typeof resolveBillingEntitlement>[0]
  return {
    entitlement: resolveBillingEntitlement(billingInput),
    plan: getEffectiveBillingPlan(billingInput),
    state: resolveBillingEntitlement(billingInput).state,
  }
}

export function decryptStoredAlertEndpoint(row: Row) {
  const agencyId = String(row.agency_id)
  const endpointId = String(row.id)
  const encryptionSecret = requireAlertEncryptionSecret()
  return {
    destination: decryptAlertValue(
      String(row.target_ciphertext),
      encryptionSecret,
      alertEncryptionAssociatedData({ agencyId, endpointId, field: "target" })
    ),
    signingSecret: row.signing_secret_ciphertext
      ? decryptAlertValue(
          String(row.signing_secret_ciphertext),
          encryptionSecret,
          alertEncryptionAssociatedData({ agencyId, endpointId, field: "signing-secret" })
        )
      : "",
  }
}

async function requireAlertFeature(agencyId: string, kind: AlertEndpointKind) {
  const entitlement = await loadAlertEntitlement(agencyId)
  if (!entitlement.entitlement.grantsPaidAccess || !entitlement.plan.features[kind]) {
    throw new BusinessEvalsApiError(
      403,
      "ALERTS_PAID_PLAN_REQUIRED",
      `${kind === "email" ? "Email alerts" : "Outbound webhooks"} require Solo, Team, Agency, or an active Team trial.`
    )
  }
}

async function normalizeAlertDestination(kind: AlertEndpointKind, rawDestination: string) {
  if (kind === "email") {
    try {
      return normalizeAlertEmail(rawDestination)
    } catch (error) {
      throw new BusinessEvalsApiError(400, "INVALID_ALERT_EMAIL", error instanceof Error ? error.message : "Enter a valid alert email address.")
    }
  }
  let parsed: URL
  try {
    parsed = new URL(rawDestination.trim())
  } catch {
    throw new BusinessEvalsApiError(400, "INVALID_WEBHOOK_URL", "Enter a valid HTTPS webhook URL.")
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new BusinessEvalsApiError(400, "INVALID_WEBHOOK_URL", "Webhook destinations must use HTTPS without credentials or fragments.")
  }
  const safety = await validateEndpointUrlForRequest(parsed.toString())
  if (!safety.ok) throw new BusinessEvalsApiError(400, "UNSAFE_WEBHOOK_URL", safety.reason)
  return safety.url.toString()
}

async function loadStoredEndpoint(agencyId: string, endpointId: string) {
  const rows = await supabaseServiceJson<Row[]>(`alert_endpoints?${query({
    select: "id,agency_id,display_name,endpoint_type,target_ciphertext,target_preview,signing_secret_ciphertext,enabled,created_at,updated_at",
    agency_id: `eq.${agencyId}`,
    id: `eq.${endpointId}`,
    limit: "1",
  })}`)
  if (!rows[0]) throw new BusinessEvalsApiError(404, "ALERT_ENDPOINT_NOT_FOUND", "Alert destination not found.")
  return rows[0]
}

function requireAlertEncryptionSecret() {
  const secret = process.env.ALERT_ENDPOINT_ENCRYPTION_KEY?.trim() ?? ""
  if (secret.length < 32) {
    throw new BusinessEvalsApiError(503, "ALERTS_NOT_CONFIGURED", "Alert endpoint encryption is not configured.")
  }
  return secret
}

function presentEndpoint(row: Row) {
  return {
    id: String(row.id),
    name: String(row.display_name ?? "Alert destination"),
    kind: String(row.endpoint_type),
    destinationPreview: String(row.target_preview),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

function presentDelivery(row: Row) {
  return {
    id: String(row.id),
    endpointId: String(row.alert_endpoint_id),
    evalRunId: row.eval_run_id ? String(row.eval_run_id) : null,
    incidentId: row.issue_id ? String(row.issue_id) : null,
    eventType: String(row.event_type),
    status: String(row.status),
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    lastError: String(row.last_error_safe ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
