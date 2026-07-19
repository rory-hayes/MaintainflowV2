import "server-only"

import { createHash } from "node:crypto"

import {
  classifyEmailReceivingHealth,
  EMAIL_RECEIVING_HEALTH_FRESHNESS_MS,
  type EmailReceivingHealth,
} from "@/lib/email/receiving-health"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export async function recordResendReceivingHealth(input: {
  webhookId: string
  recipients: string[]
  inboundDomain: string
}) {
  const inboundDomain = normalizeHostname(input.inboundDomain)
  if (!input.recipients.some((recipient) => recipientDomain(recipient) === inboundDomain)) return false
  const providerEventIdHash = createHash("sha256").update(input.webhookId).digest("hex")
  await supabaseServiceJson(
    "eval_email_receiving_health_events?on_conflict=provider,provider_event_id_hash",
    {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify({
        provider: "resend",
        inbound_domain: inboundDomain,
        provider_event_id_hash: providerEventIdHash,
      }),
    }
  )
  return true
}

export async function loadResendReceivingHealth(input: {
  inboundDomain: string
  submissionCompletedAt: string
  maximumWaitSeconds: number
}): Promise<EmailReceivingHealth> {
  const inboundDomain = normalizeHostname(input.inboundDomain)
  const submissionMs = Date.parse(input.submissionCompletedAt)
  if (!Number.isFinite(submissionMs)) {
    return classifyEmailReceivingHealth(input)
  }
  const deadlineMs = submissionMs + input.maximumWaitSeconds * 1_000
  const healthyWindowStartMs = deadlineMs - EMAIL_RECEIVING_HEALTH_FRESHNESS_MS
  const rows = await supabaseServiceJson<Row[]>(`eval_email_receiving_health_events?${query({
    select: "observed_at",
    provider: "eq.resend",
    inbound_domain: `eq.${inboundDomain}`,
    and: `(observed_at.gte.${new Date(healthyWindowStartMs).toISOString()},observed_at.lte.${new Date(deadlineMs).toISOString()})`,
    order: "observed_at.desc",
    limit: "1",
  })}`)
  return classifyEmailReceivingHealth({
    ...input,
    observedAt: rows[0]?.observed_at ? String(rows[0].observed_at) : null,
  })
}

function recipientDomain(value: string) {
  const address = value.match(/<([^>]+)>/)?.[1] ?? value
  return address.trim().toLowerCase().split("@")[1]?.replace(/^\.+|\.+$/g, "") ?? ""
}

function normalizeHostname(value: string) {
  const hostname = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error("A valid inbound email hostname is required.")
  }
  return hostname
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
