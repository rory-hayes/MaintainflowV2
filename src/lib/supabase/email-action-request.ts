import { z } from "zod"

import { AUTH_PASSWORD_MIN_LENGTH } from "../auth/signup-validation.ts"
import {
  MAINTAINFLOW_PRIVACY_VERSION,
  MAINTAINFLOW_TERMS_VERSION,
} from "../legal/acceptance.ts"

export const EMAIL_ACTION_MAX_BODY_BYTES = 4_096

const tokenHashSchema = z.string()
  .min(20)
  .max(2_048)
  .regex(/^[A-Za-z0-9._~-]+$/)

const emailActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("email"),
    tokenHash: tokenHashSchema,
  }).strict(),
  z.object({
    type: z.literal("recovery"),
    tokenHash: tokenHashSchema,
    password: z.string().min(AUTH_PASSWORD_MIN_LENGTH).max(1_024),
    legalAcceptance: z.object({
      accepted: z.literal(true),
      termsVersion: z.literal(MAINTAINFLOW_TERMS_VERSION),
      privacyVersion: z.literal(MAINTAINFLOW_PRIVACY_VERSION),
      source: z.literal("password_reset"),
    }).strict(),
  }).strict(),
])

export type EmailActionRequestInput = z.infer<typeof emailActionSchema>

type EmailActionRequest = {
  headers: Pick<Headers, "get">
  nextUrl: { origin: string }
  text(): Promise<string>
}

export class EmailActionRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "EmailActionRequestError"
    this.status = status
    this.code = code
  }
}

export async function parseEmailActionRequest(request: EmailActionRequest): Promise<EmailActionRequestInput> {
  if (!isSameOriginBrowserRequest(request)) {
    throw new EmailActionRequestError(403, "FORBIDDEN", "This email action must be completed from Maintain Flow.")
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new EmailActionRequestError(415, "UNSUPPORTED_CONTENT_TYPE", "This email action request was not valid.")
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > EMAIL_ACTION_MAX_BODY_BYTES) {
    throw new EmailActionRequestError(413, "REQUEST_TOO_LARGE", "This email action request was too large.")
  }

  const rawBody = await request.text().catch(() => "")
  if (new TextEncoder().encode(rawBody).byteLength > EMAIL_ACTION_MAX_BODY_BYTES) {
    throw new EmailActionRequestError(413, "REQUEST_TOO_LARGE", "This email action request was too large.")
  }

  let rawInput: unknown
  try {
    rawInput = JSON.parse(rawBody)
  } catch {
    throw new EmailActionRequestError(400, "INVALID_REQUEST", "This email action request was not valid.")
  }

  const input = emailActionSchema.safeParse(rawInput)
  if (!input.success) {
    throw new EmailActionRequestError(400, "INVALID_REQUEST", "This email action link or form was not valid.")
  }

  return input.data
}

export function isSameOriginBrowserRequest(request: Pick<EmailActionRequest, "headers" | "nextUrl">) {
  const origin = request.headers.get("origin")
  if (!origin) return false

  let requestOrigin = ""
  try {
    requestOrigin = new URL(origin).origin
  } catch {
    return false
  }

  const fetchSite = request.headers.get("sec-fetch-site")
  return requestOrigin === request.nextUrl.origin && (!fetchSite || fetchSite === "same-origin")
}
