import "server-only"

import { createHash } from "node:crypto"

import { Resend, type EmailReceivedEvent } from "resend"

import {
  deriveEvalEmailHookToken,
  extractAllowlistedVerificationLink,
  inboundMessageContainsMarker,
  journeyIdFromForwardingRecipient,
  recipientHash,
  recipientMatchesRun,
  safeInboundEmailMetadata,
} from "@/lib/email/eval-inbound"
import { recordResendReceivingHealth } from "@/lib/email/resend-receiving-health.server"
import { encryptVerificationLink } from "@/lib/email/verification-link-crypto"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { evalEmailHook } from "@/workflows/eval-run"

type Row = Record<string, unknown>

export async function processResendInboundWebhook(input: {
  rawBody: string
  webhookId: string
  webhookTimestamp: string
  webhookSignature: string
}) {
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_000_000) {
    throw new InboundWebhookError(413, "WEBHOOK_TOO_LARGE", "Inbound webhook payload is too large.")
  }
  const apiKey = requireEnv("RESEND_API_KEY")
  const webhookSecret = requireSecret("RESEND_INBOUND_WEBHOOK_SECRET")
  const routingSecret = requireSecret("EVAL_EMAIL_ROUTING_SECRET")
  const resend = new Resend(apiKey)
  let event: EmailReceivedEvent
  try {
    const verified = resend.webhooks.verify({
      payload: input.rawBody,
      headers: {
        id: input.webhookId,
        timestamp: input.webhookTimestamp,
        signature: input.webhookSignature,
      },
      webhookSecret,
    })
    if (verified.type !== "email.received") return { accepted: true, ignored: true, duplicate: false }
    event = verified
  } catch {
    throw new InboundWebhookError(401, "INVALID_SIGNATURE", "Inbound email signature verification failed.")
  }

  const duplicate = await findInboundEvent(input.webhookId)
  if (duplicate) return { accepted: true, ignored: false, duplicate: true }

  const inboundDomain = normalizeHost(requireEnv("EVAL_INBOUND_DOMAIN"))
  const recipients = [...new Set([...event.data.to, ...event.data.received_for]
    .map((address) => address.trim().toLowerCase())
    .filter((address) => recipientDomain(address) === inboundDomain))]
  const recipientHashes = recipients.map(recipientHash)
  if (!recipientHashes.length) return { accepted: true, ignored: true, duplicate: false }
  const directRuns = await supabaseServiceJson<Row[]>(`eval_runs?${query({
    select: "id,agency_id,client_id,workflow_id,journey_version_id,recipient_hash,status",
    recipient_hash: `in.(${recipientHashes.join(",")})`,
    status: "in.(claimed,running)",
    order: "created_at.desc",
    limit: "5",
  })}`)
  const directRun = directRuns.find((candidate) => recipients.some((address) => recipientMatchesRun(address, String(candidate.id), routingSecret)))
  const forwardingJourneyIds = [...new Set(recipients
    .map((address) => journeyIdFromForwardingRecipient(address, routingSecret))
    .filter((value): value is string => Boolean(value)))]
  const forwardingRuns = forwardingJourneyIds.length
    ? await supabaseServiceJson<Row[]>(`eval_runs?${query({
        select: "id,agency_id,client_id,workflow_id,journey_version_id,recipient_hash,synthetic_marker,status",
        workflow_id: `in.(${forwardingJourneyIds.join(",")})`,
        status: "in.(claimed,running)",
        order: "created_at.desc",
        limit: "50",
      })}`)
    : []
  const receiving = await resend.emails.receiving.get(event.data.email_id, { html_format: "cid" })
  if (receiving.error || !receiving.data) {
    throw new InboundWebhookError(503, "EMAIL_RETRIEVAL_FAILED", "The signed email event was accepted but its content could not be retrieved.")
  }
  await recordResendReceivingHealth({
    webhookId: input.webhookId,
    recipients,
    inboundDomain,
  })
  if (!directRun && !forwardingRuns.length) return { accepted: true, ignored: true, duplicate: false }
  const retrievedContentBytes = Buffer.byteLength(
    `${receiving.data.subject ?? ""}\n${receiving.data.text ?? ""}\n${receiving.data.html ?? ""}`,
    "utf8"
  )
  if (retrievedContentBytes > 2_000_000) {
    throw new InboundWebhookError(413, "EMAIL_CONTENT_TOO_LARGE", "The received email content exceeds the safe matching limit.")
  }
  let run: Row | undefined
  let inboundRules: Awaited<ReturnType<typeof loadInboundRules>> | undefined
  let matchedRecipient: string | undefined
  if (directRun) {
    const rules = await loadInboundRules(String(directRun.agency_id), String(directRun.journey_version_id))
    if (rules.proofMode === "autoresponse") {
      run = directRun
      inboundRules = rules
      matchedRecipient = recipients.find((address) => recipientMatchesRun(address, String(directRun.id), routingSecret))
    }
  }
  if (!run && forwardingRuns.length) {
    const markerMatches = forwardingRuns.filter((candidate) => inboundMessageContainsMarker({
      marker: String(candidate.synthetic_marker),
      subject: receiving.data.subject,
      text: receiving.data.text,
      html: receiving.data.html,
    }))
    if (markerMatches.length === 1) {
      const candidate = markerMatches[0]
      const rules = await loadInboundRules(String(candidate.agency_id), String(candidate.journey_version_id))
      if (rules.proofMode === "forwarded_marker") {
        run = candidate
        inboundRules = rules
        matchedRecipient = recipients.find((address) => journeyIdFromForwardingRecipient(address, routingSecret) === String(candidate.workflow_id))
      }
    }
  }
  if (!run || !inboundRules || !matchedRecipient) return { accepted: true, ignored: true, duplicate: false }

  const { linkRules, emailStageId, proofMode } = inboundRules
  const link = extractAllowlistedVerificationLink({
    text: receiving.data.text,
    html: receiving.data.html,
    rules: linkRules,
  })
  const metadata = safeInboundEmailMetadata({
    emailId: receiving.data.id,
    messageId: receiving.data.message_id,
    from: receiving.data.from,
    to: receiving.data.to,
    subject: receiving.data.subject,
    createdAt: receiving.data.created_at,
    link,
  })
  const matchedRecipientHash = recipientHash(matchedRecipient)
  const eventId = crypto.randomUUID()
  const verificationLinkCiphertext = link
    ? encryptVerificationLink(link, requireVerificationLinkKey(), {
        agencyId: String(run.agency_id),
        runId: String(run.id),
        eventId,
      })
    : null
  try {
    await supabaseServiceJson("inbound_email_events", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        id: eventId,
        agency_id: run.agency_id,
        client_id: run.client_id,
        eval_run_id: run.id,
        stage_definition_id: emailStageId,
        provider: "resend",
        provider_event_id: input.webhookId,
        recipient_hash: matchedRecipientHash,
        sender_domain: metadata.senderDomain,
        subject_safe: `sha256:${metadata.subjectHash}`,
        match_key_hash: createHash("sha256").update(`${run.id}:${input.webhookId}:${matchedRecipientHash}`).digest("hex"),
        payload_summary_json: {
          ...metadata,
          verificationLinkCiphertext,
          proofMode,
          markerMatched: proofMode === "forwarded_marker",
        },
        received_at: metadata.receivedAt,
      }),
    })
  } catch (error) {
    if (await findInboundEvent(input.webhookId)) return { accepted: true, ignored: false, duplicate: true }
    throw error
  }

  await evalEmailHook.resume(deriveEvalEmailHookToken(String(run.id), routingSecret), {
    kind: "email",
    inboundEventId: eventId,
    receivedAt: metadata.receivedAt,
  }).catch(() => undefined)

  return { accepted: true, ignored: false, duplicate: false, evalRunId: String(run.id) }
}

async function loadInboundRules(agencyId: string, journeyVersionId: string) {
  const [versions, stages] = await Promise.all([
    supabaseServiceJson<Row[]>(`journey_versions?${query({
      select: "authorization_id,start_url",
      agency_id: `eq.${agencyId}`,
      id: `eq.${journeyVersionId}`,
      limit: "1",
    })}`),
    supabaseServiceJson<Row[]>(`journey_stage_definitions?${query({
      select: "id,position,action_manifest_json",
      agency_id: `eq.${agencyId}`,
      journey_version_id: `eq.${journeyVersionId}`,
      order: "position.asc",
    })}`),
  ])
  const version = versions[0]
  if (!version) throw new InboundWebhookError(409, "JOURNEY_VERSION_MISSING", "The receiving journey version no longer exists.")
  const authorizationId = String(version.authorization_id ?? "")
  const authorizations = authorizationId
    ? await supabaseServiceJson<Row[]>(`project_authorizations?${query({
        select: "hostname,approved_action_domains,revoked_at",
        agency_id: `eq.${agencyId}`,
        id: `eq.${authorizationId}`,
        revoked_at: "is.null",
        limit: "1",
      })}`)
    : []
  const authorization = authorizations[0]
  if (!authorization) throw new InboundWebhookError(409, "AUTHORIZATION_REVOKED", "The project owner attestation has been revoked.")
  const approved = new Set([
    normalizeHost(String(authorization.hostname ?? "")),
    ...(Array.isArray(authorization.approved_action_domains) ? authorization.approved_action_domains.map((value) => normalizeHost(String(value))) : []),
  ].filter(Boolean))
  const configuredLinkRules: Array<{
    host: string
    pathPrefix: string
    requiredText?: string
    requiredQueryParameter?: string
  }> = []
  let emailStageId: string | null = null
  let proofMode: "autoresponse" | "forwarded_marker" | null = null
  for (const stage of stages) {
    const manifest = stage.action_manifest_json as Row | undefined
    const actions = Array.isArray(manifest?.actions) ? manifest.actions as Row[] : []
    for (const action of actions) {
      if (action.type === "wait_for_email" && !emailStageId) {
        emailStageId = String(stage.id)
        proofMode = action.proofMode === "forwarded_marker" ? "forwarded_marker" : "autoresponse"
      }
      if (action.type === "open_email_link" && Array.isArray(action.allowedHosts)) {
        const rule = isRecord(action.linkRule) ? action.linkRule : null
        if (rule) {
          configuredLinkRules.push({
            host: normalizeHost(String(rule.host ?? "")),
            pathPrefix: String(rule.pathPrefix ?? ""),
            ...(typeof rule.requiredText === "string" && rule.requiredText.trim() ? { requiredText: rule.requiredText.trim() } : {}),
            ...(typeof rule.requiredQueryParameter === "string" && rule.requiredQueryParameter.trim() ? { requiredQueryParameter: rule.requiredQueryParameter.trim() } : {}),
          })
        }
      }
    }
  }
  if (!emailStageId || !proofMode) {
    throw new InboundWebhookError(409, "EMAIL_STAGE_MISSING", "The published journey does not contain an email proof stage.")
  }
  const linkRules = configuredLinkRules.filter((rule) => rule.host && rule.pathPrefix.startsWith("/")
    && [...approved].some((domain) => rule.host === domain || rule.host.endsWith(`.${domain}`)))
  if (proofMode === "autoresponse" && !linkRules.length && stages.some((stage) => {
    const manifest = stage.action_manifest_json as Row | undefined
    return Array.isArray(manifest?.actions) && (manifest.actions as Row[]).some((action) => action.type === "open_email_link")
  })) {
    throw new InboundWebhookError(409, "VERIFICATION_LINK_RULE_MISSING", "The published trial journey does not contain a safe verification-link matching rule.")
  }
  return { linkRules, emailStageId, proofMode }
}

async function findInboundEvent(providerEventId: string) {
  const rows = await supabaseServiceJson<Row[]>(`inbound_email_events?${query({
    select: "id",
    provider: "eq.resend",
    provider_event_id: `eq.${providerEventId}`,
    limit: "1",
  })}`)
  return rows[0] ?? null
}

export class InboundWebhookError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "InboundWebhookError"
    this.status = status
    this.code = code
  }
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim() ?? ""
  if (!value) throw new InboundWebhookError(503, "INBOUND_NOT_CONFIGURED", `${name} is not configured.`)
  return value
}

function requireSecret(name: string) {
  const value = requireEnv(name)
  if (value.length < 32) throw new InboundWebhookError(503, "INBOUND_NOT_CONFIGURED", `${name} must contain at least 32 characters.`)
  return value
}

function requireVerificationLinkKey() {
  return requireEnv("EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64")
}

function normalizeHost(value: string) {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
}

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function recipientDomain(value: string) {
  const address = value.match(/<([^>]+)>/)?.[1] ?? value
  return address.trim().toLowerCase().split("@")[1]?.replace(/^\.+|\.+$/g, "") ?? ""
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
