import "server-only"

import { Resend } from "resend"

import { loadAlertEntitlement, decryptStoredAlertEndpoint, queueFinalizedEvalAlerts } from "@/lib/api/alerts.server"
import { alertEmailMessage, safeAlertText } from "@/lib/api/alerts-shared"
import { deliverOutboundWebhookOnce, type SafeAlertEvent } from "@/lib/alerts/outbound-webhook.server"
import { nextWebhookAttemptAt } from "@/lib/alerts/outbound-webhook"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>
type EmailSender = (input: { to: string; subject: string; text: string; idempotencyKey: string }) => Promise<void>

export async function deliverPendingEvalAlerts(input: {
  batchSize: number
  now?: Date
  sendEmail?: EmailSender
}) {
  const now = input.now ?? new Date()
  const outbox = await reconcileFinalizedEvalAlertOutbox(Math.max(1, Math.min(input.batchSize, 25)), now)
  const candidates = await loadDeliveryCandidates(Math.max(1, Math.min(input.batchSize, 25)), now)
  const summary = { claimed: 0, delivered: 0, retried: 0, failed: 0, suppressed: 0, outbox }

  for (const candidate of candidates) {
    const claimed = await claimDelivery(candidate, now)
    if (!claimed) continue
    summary.claimed += 1
    const attempt = Number(claimed.attempt_count)
    try {
      const endpoint = await loadEndpointForDelivery(claimed)
      if (!endpoint.enabled) {
        await finishDelivery(claimed, "suppressed", "This alert destination is disabled.", null, now)
        summary.suppressed += 1
        continue
      }
      const entitlement = await loadAlertEntitlement(String(claimed.agency_id))
      const kind = String(endpoint.endpoint_type) as "email" | "webhook"
      if (!entitlement.entitlement.grantsPaidAccess || !entitlement.plan.features[kind]) {
        await finishDelivery(claimed, "suppressed", "The paid alert entitlement is inactive.", null, now)
        summary.suppressed += 1
        continue
      }

      const event = await buildSafeAlertEvent(claimed)
      const secrets = decryptStoredAlertEndpoint(endpoint)
      if (kind === "email") {
        const message = alertEmailMessage({
          eventId: event.id,
          eventType: event.type,
          status: event.status,
          summary: event.summary,
          dashboardUrl: event.dashboardUrl,
        })
        await (input.sendEmail ?? sendResendAlertEmail)({
          to: secrets.destination,
          idempotencyKey: event.id,
          ...message,
        })
        await finishDelivery(claimed, "delivered", "", null, now)
        summary.delivered += 1
        continue
      }

      if (!secrets.signingSecret) {
        await finishDelivery(claimed, "failed", "The webhook signing secret is unavailable.", null, now)
        summary.failed += 1
        continue
      }
      const result = await deliverOutboundWebhookOnce({
        url: secrets.destination,
        secret: secrets.signingSecret,
        event,
        attempt,
      })
      if (result.delivered) {
        await finishDelivery(claimed, "delivered", "", null, now)
        summary.delivered += 1
      } else if (result.retryable && attempt < 8) {
        await finishDelivery(claimed, "failed", result.responseSummary, nextWebhookAttemptAt(attempt, now.getTime()), now)
        summary.retried += 1
      } else {
        await finishDelivery(claimed, "failed", result.responseSummary, null, now)
        summary.failed += 1
      }
    } catch {
      const nextAttemptAt = nextWebhookAttemptAt(attempt, now.getTime())
      await finishDelivery(
        claimed,
        "failed",
        "Delivery failed before a safe response was received.",
        attempt < 8 ? nextAttemptAt : null,
        now
      )
      if (attempt < 8 && nextAttemptAt) summary.retried += 1
      else summary.failed += 1
    }
  }

  return summary
}

export async function reconcileFinalizedEvalAlertOutbox(batchSize: number, now = new Date()) {
  const ready = await supabaseServiceJson<Row[]>(`eval_alert_outbox?${query({
    select: "id,agency_id,eval_run_id,issue_id,status,attempt_count,next_attempt_at,updated_at",
    status: "in.(pending,failed)",
    next_attempt_at: `lte.${now.toISOString()}`,
    attempt_count: "lt.8",
    order: "next_attempt_at.asc,created_at.asc",
    limit: String(Math.max(1, Math.min(batchSize, 25))),
  })}`)
  const staleBefore = new Date(now.getTime() - 15 * 60_000).toISOString()
  const stale = ready.length >= batchSize
    ? []
    : await supabaseServiceJson<Row[]>(`eval_alert_outbox?${query({
        select: "id,agency_id,eval_run_id,issue_id,status,attempt_count,next_attempt_at,updated_at",
        status: "eq.processing",
        updated_at: `lt.${staleBefore}`,
        attempt_count: "lt.8",
        order: "updated_at.asc",
        limit: String(Math.max(0, Math.min(batchSize, 25) - ready.length)),
      })}`)
  const summary = { found: ready.length + stale.length, processed: 0, failed: 0 }
  for (const item of [...ready, ...stale]) {
    try {
      await queueFinalizedEvalAlerts({
        agencyId: String(item.agency_id),
        evalRunId: String(item.eval_run_id),
        incidentId: item.issue_id ? String(item.issue_id) : null,
      })
      summary.processed += 1
    } catch {
      summary.failed += 1
    }
  }
  return summary
}

async function loadDeliveryCandidates(batchSize: number, now: Date) {
  const due = await supabaseServiceJson<Row[]>(`alert_deliveries?${query({
    select: "id,agency_id,alert_endpoint_id,eval_run_id,issue_id,event_type,status,attempt_count,next_attempt_at,updated_at",
    status: "in.(pending,failed)",
    next_attempt_at: `lte.${now.toISOString()}`,
    attempt_count: "lt.8",
    order: "next_attempt_at.asc,created_at.asc",
    limit: String(batchSize),
  })}`)
  if (due.length >= batchSize) return due

  // A worker can disappear after claiming a row. Reclaim a bounded stale send so
  // deliveries are durable without treating a live attempt as failed.
  const staleBefore = new Date(now.getTime() - 15 * 60_000).toISOString()
  const stale = await supabaseServiceJson<Row[]>(`alert_deliveries?${query({
    select: "id,agency_id,alert_endpoint_id,eval_run_id,issue_id,event_type,status,attempt_count,next_attempt_at,updated_at",
    status: "eq.sending",
    updated_at: `lt.${staleBefore}`,
    attempt_count: "lt.8",
    order: "updated_at.asc",
    limit: String(batchSize - due.length),
  })}`)
  return [...due, ...stale]
}

async function claimDelivery(candidate: Row, now: Date) {
  const filters: Record<string, string> = {
    id: `eq.${String(candidate.id)}`,
    agency_id: `eq.${String(candidate.agency_id)}`,
    status: `eq.${String(candidate.status)}`,
    attempt_count: `eq.${Number(candidate.attempt_count ?? 0)}`,
    select: "id,agency_id,alert_endpoint_id,eval_run_id,issue_id,event_type,status,attempt_count",
  }
  if (candidate.status === "sending") filters.updated_at = `eq.${String(candidate.updated_at)}`
  else filters.next_attempt_at = `eq.${String(candidate.next_attempt_at)}`
  const rows = await supabaseServiceJson<Row[]>(`alert_deliveries?${query(filters)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "sending",
      attempt_count: Number(candidate.attempt_count ?? 0) + 1,
      next_attempt_at: null,
      last_error_safe: "",
      updated_at: now.toISOString(),
    }),
  })
  return rows[0] ?? null
}

async function loadEndpointForDelivery(delivery: Row) {
  const rows = await supabaseServiceJson<Row[]>(`alert_endpoints?${query({
    select: "id,agency_id,endpoint_type,target_ciphertext,signing_secret_ciphertext,enabled",
    id: `eq.${String(delivery.alert_endpoint_id)}`,
    agency_id: `eq.${String(delivery.agency_id)}`,
    limit: "1",
  })}`)
  if (!rows[0]) throw new Error("Alert endpoint not found.")
  return rows[0]
}

async function buildSafeAlertEvent(delivery: Row): Promise<SafeAlertEvent> {
  const agencyId = String(delivery.agency_id)
  const eventId = String(delivery.id)
  const eventType = String(delivery.event_type)
  const origin = alertAppOrigin()
  if (delivery.eval_run_id) {
    if (eventType !== "eval_run.completed") throw new Error("Unsupported eval-run alert type.")
    const rows = await supabaseServiceJson<Row[]>(`eval_runs?${query({
      select: "id,agency_id,client_id,workflow_id,status,verdict,summary,completed_at,created_at",
      id: `eq.${String(delivery.eval_run_id)}`,
      agency_id: `eq.${agencyId}`,
      limit: "1",
    })}`)
    const run = rows[0]
    if (!run) throw new Error("Eval run not found.")
    return {
      id: eventId,
      type: "eval_run.completed",
      createdAt: String(run.completed_at ?? run.created_at),
      workspaceId: agencyId,
      projectId: String(run.client_id),
      journeyId: String(run.workflow_id),
      runId: String(run.id),
      status: safeAlertText(run.verdict ?? run.status, "completed", 80),
      summary: safeAlertText(run.summary, "The business eval completed. Open Maintain Flow to review its deterministic result."),
      dashboardUrl: `${origin}/eval-runs/${encodeURIComponent(String(run.id))}`,
    }
  }

  if (delivery.issue_id) {
    if (eventType !== "incident.opened" && eventType !== "incident.recovered") {
      throw new Error("Unsupported incident alert type.")
    }
    const rows = await supabaseServiceJson<Row[]>(`issues?${query({
      select: "id,agency_id,client_id,workflow_id,status,title,report_safe_summary,resolved_at,created_at",
      id: `eq.${String(delivery.issue_id)}`,
      agency_id: `eq.${agencyId}`,
      limit: "1",
    })}`)
    const issue = rows[0]
    if (!issue) throw new Error("Incident not found.")
    return {
      id: eventId,
      type: eventType,
      createdAt: String(issue.resolved_at ?? issue.created_at),
      workspaceId: agencyId,
      projectId: String(issue.client_id),
      journeyId: String(issue.workflow_id),
      incidentId: String(issue.id),
      status: safeAlertText(issue.status, eventType === "incident.recovered" ? "recovered" : "open", 80),
      summary: safeAlertText(
        issue.report_safe_summary ?? issue.title,
        eventType === "incident.recovered" ? "A verified recovery was recorded." : "A business eval incident was opened."
      ),
      dashboardUrl: `${origin}/incidents/${encodeURIComponent(String(issue.id))}`,
    }
  }
  throw new Error("Alert delivery source not found.")
}

async function finishDelivery(
  delivery: Row,
  status: "delivered" | "failed" | "suppressed",
  lastErrorSafe: string,
  nextAttemptAt: string | null,
  now: Date
) {
  await supabaseServiceJson(`alert_deliveries?${query({
    id: `eq.${String(delivery.id)}`,
    agency_id: `eq.${String(delivery.agency_id)}`,
    status: "eq.sending",
    attempt_count: `eq.${Number(delivery.attempt_count)}`,
  })}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      status,
      next_attempt_at: nextAttemptAt,
      delivered_at: status === "delivered" ? now.toISOString() : null,
      last_error_safe: safeAlertText(lastErrorSafe, "", 300),
      updated_at: now.toISOString(),
    }),
  })
}

async function sendResendAlertEmail(input: { to: string; subject: string; text: string; idempotencyKey: string }) {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? ""
  const from = process.env.MAINTAINFLOW_ALERT_FROM_EMAIL?.trim() ?? ""
  if (!apiKey || !from) throw new Error("Alert email delivery is not configured.")
  const response = await new Resend(apiKey).emails.send(
    {
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    },
    { idempotencyKey: input.idempotencyKey }
  )
  if (response.error) throw new Error("The alert email provider rejected the delivery.")
}

function alertAppOrigin() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || "https://www.maintainflow.io"
  const url = new URL(configured)
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("The production alert origin must use HTTPS.")
  }
  return url.origin
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
