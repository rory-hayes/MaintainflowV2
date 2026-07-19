import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import { syntheticMarker } from "../evals/synthetic.ts"

const markerVersion = "v1"

export function createEvalRecipient(input: {
  runId: string
  secret: string
  domain: string
}) {
  const domain = normalizeHostname(input.domain)
  const marker = recipientMarker(input.runId, input.secret)
  return `run-${marker}@${domain}`
}

export function createJourneyForwardingRecipient(input: {
  journeyId: string
  secret: string
  domain: string
}) {
  const journeyId = normalizedUuid(input.journeyId)
  const domain = normalizeHostname(input.domain)
  return `journey-${journeyId}-${journeyMarker(journeyId, input.secret)}@${domain}`
}

export function recipientHash(address: string) {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex")
}

export function deriveEvalEmailHookToken(runId: string, secret: string) {
  requireSecret(secret)
  return `eval-email:${markerVersion}:${createHmac("sha256", secret).update(`hook:${runId}`).digest("base64url")}`
}

export function recipientMatchesRun(address: string, runId: string, secret: string) {
  const actual = address.trim().toLowerCase().split("@")[0]?.replace(/^run-/, "") ?? ""
  const expected = recipientMarker(runId, secret)
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function journeyIdFromForwardingRecipient(address: string, secret: string) {
  const local = address.trim().toLowerCase().split("@")[0] ?? ""
  const match = local.match(/^journey-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{16})$/)
  if (!match) return null
  const journeyId = match[1]
  const actual = Buffer.from(match[2])
  const expected = Buffer.from(journeyMarker(journeyId, secret))
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? journeyId : null
}

export function submittedMarkerForRun(runId: string) {
  return syntheticMarker(runId)
}

export function inboundMessageContainsMarker(input: {
  marker: string
  subject?: string | null
  text?: string | null
  html?: string | null
}) {
  if (!/^MF-EVAL-[A-F0-9]{20}$/.test(input.marker)) return false
  const source = `${input.subject ?? ""}\n${input.text ?? ""}\n${decodeBasicHtml(input.html ?? "")}`
  const escaped = input.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[^A-Z0-9-])${escaped}(?:$|[^A-Z0-9-])`).test(source)
}

export type PublishedVerificationLinkRule = {
  host: string
  pathPrefix: string
  requiredText?: string
  requiredQueryParameter?: string
}

export function extractAllowlistedVerificationLink(input: {
  text?: string | null
  html?: string | null
  rules: PublishedVerificationLinkRule[]
}) {
  const rules = input.rules.map((rule) => ({
    host: normalizeHostname(rule.host),
    pathPrefix: normalizePathPrefix(rule.pathPrefix),
    requiredText: rule.requiredText?.trim().toLowerCase() || "",
    requiredQueryParameter: rule.requiredQueryParameter?.trim() || "",
  }))
  const candidates = collectLinkCandidates(input.text ?? "", input.html ?? "")
  const matches = new Map<string, string>()
  for (const candidate of candidates.slice(0, 100)) {
    try {
      const url = new URL(candidate.href.replace(/&amp;/g, "&"))
      const hostname = url.hostname.toLowerCase()
      if (url.username || url.password) continue
      const rule = rules.find((item) => hostname === item.host
        && pathMatchesRule(url.pathname, item.pathPrefix)
        && (!item.requiredText || candidate.text.toLowerCase().includes(item.requiredText))
        && (!item.requiredQueryParameter || url.searchParams.has(item.requiredQueryParameter)))
      if (!rule) continue
      url.hash = ""
      matches.set(url.toString(), url.toString())
    } catch {
      continue
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : null
}

function collectLinkCandidates(text: string, html: string) {
  const candidates: Array<{ href: string; text: string }> = []
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(anchorPattern)) {
    candidates.push({ href: decodeHtmlEntities(match[2] ?? ""), text: decodeBasicHtml(match[3] ?? "").trim() })
  }
  const source = `${text}\n${decodeBasicHtml(html)}`
  for (const href of source.match(/https:\/\/[^\s<>"')\]]+/gi) ?? []) {
    candidates.push({ href: href.replace(/[.,;:!?]+$/, ""), text: "" })
  }
  return candidates
}

function normalizePathPrefix(value: string) {
  const path = value.trim()
  if (!path.startsWith("/") || /[?#]/.test(path)) throw new Error("A verification-link rule requires a safe path prefix.")
  return path
}

function pathMatchesRule(pathname: string, pathPrefix: string) {
  if (pathPrefix === "/") return pathname.startsWith("/")
  const normalized = pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

export function safeInboundEmailMetadata(input: {
  emailId: string
  messageId: string
  from: string
  to: string[]
  subject: string
  createdAt: string
  link: string | null
}) {
  return {
    providerEmailId: input.emailId.slice(0, 200),
    providerMessageIdHash: createHash("sha256").update(input.messageId).digest("hex"),
    senderDomain: senderDomain(input.from),
    recipientHashes: input.to.map(recipientHash),
    subjectHash: createHash("sha256").update(input.subject).digest("hex"),
    receivedAt: input.createdAt,
    verificationLinkHash: input.link ? createHash("sha256").update(input.link).digest("hex") : null,
  }
}

function recipientMarker(runId: string, secret: string) {
  requireSecret(secret)
  return createHmac("sha256", secret).update(`recipient:${runId}`).digest("base64url").slice(0, 32).toLowerCase()
}

function journeyMarker(journeyId: string, secret: string) {
  requireSecret(secret)
  return createHmac("sha256", secret).update(`journey:${journeyId}`).digest("hex").slice(0, 16)
}

function normalizedUuid(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("A valid journey identifier is required.")
  }
  return normalized
}

function requireSecret(secret: string) {
  if (secret.trim().length < 32) throw new Error("EVAL_EMAIL_ROUTING_SECRET must contain at least 32 characters.")
}

function normalizeHostname(value: string) {
  const hostname = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error("A valid inbound email hostname is required.")
  }
  return hostname
}

function decodeBasicHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function senderDomain(from: string) {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from
  return address.trim().toLowerCase().split("@")[1]?.slice(0, 253) ?? ""
}
