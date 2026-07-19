import "server-only"

import { validateEndpointUrlForRequest } from "@/lib/core/endpoint-safety.server"
import { pinnedEndpointFetch } from "@/lib/core/pinned-http.server"
import { signAlertWebhook } from "@/lib/alerts/outbound-webhook"

export type SafeAlertEvent = {
  id: string
  type: "eval_run.completed" | "incident.opened" | "incident.recovered" | "report.ready"
  createdAt: string
  workspaceId: string
  projectId: string
  journeyId?: string
  runId?: string
  incidentId?: string
  reportId?: string
  status: string
  summary: string
  dashboardUrl: string
}

export async function deliverOutboundWebhookOnce(input: {
  url: string
  secret: string
  event: SafeAlertEvent
  attempt: number
  fetchImpl?: typeof pinnedEndpointFetch
}) {
  if (input.attempt < 1 || input.attempt > 8) throw new Error("Webhook delivery attempts must be between 1 and 8.")
  const safety = await validateEndpointUrlForRequest(input.url)
  if (!safety.ok) throw new Error(safety.reason)

  const payload = JSON.stringify(input.event)
  const timestamp = Math.floor(Date.now() / 1_000)
  const signature = signAlertWebhook(payload, input.secret, timestamp)
  const response = await (input.fetchImpl ?? pinnedEndpointFetch)(safety.url, safety.addresses, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Maintain-Flow-Alerts/1.0",
      "X-MaintainFlow-Event-Id": input.event.id,
      "X-MaintainFlow-Timestamp": String(timestamp),
      "X-MaintainFlow-Signature": `v1=${signature}`,
      "X-MaintainFlow-Attempt": String(input.attempt),
    },
    body: payload,
  })

  const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
  return {
    delivered: response.ok,
    statusCode: response.status,
    retryable,
    responseSummary: `HTTP ${response.status}`,
  }
}
