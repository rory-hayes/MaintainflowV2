import { createHash } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"
import { Resend } from "resend"
import { z } from "zod"

import { controlledFixtureScenario, isControlledFixtureEnabled } from "@/lib/evals/controlled-fixtures"
import { createControlledFixtureToken } from "@/lib/evals/controlled-fixture-token.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const fixtureSubmissionSchema = z.object({
  scenario: z.string().transform((value, context) => {
    const scenario = controlledFixtureScenario(value)
    if (!scenario) {
      context.addIssue({ code: "custom", message: "Unsupported fixture scenario." })
      return z.NEVER
    }
    return scenario
  }),
  name: z.string().trim().min(1).max(160),
  email: z.email().max(320),
  marker: z.string().trim().max(128),
  message: z.string().trim().max(2_000).default(""),
  workspace: z.string().trim().max(160).default(""),
})

export async function POST(request: NextRequest) {
  if (!isControlledFixtureEnabled()) return NextResponse.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404 })
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > 16_384) return errorResponse(413, "FIXTURE_TOO_LARGE", "The controlled fixture payload is too large.")
  let input: z.infer<typeof fixtureSubmissionSchema>
  try {
    input = fixtureSubmissionSchema.parse(JSON.parse(raw))
  } catch {
    return errorResponse(400, "INVALID_FIXTURE_SUBMISSION", "Use the controlled fixture fields and clearly marked synthetic values.")
  }
  const marker = exactSyntheticMarker(input.marker)
  if (!marker) return errorResponse(400, "SYNTHETIC_MARKER_REQUIRED", "A valid MF-EVAL marker is required in the synthetic name, message or workspace value.")
  const inboundDomain = process.env.EVAL_INBOUND_DOMAIN?.trim().toLowerCase() ?? ""
  if (!inboundDomain || recipientDomain(input.email) !== inboundDomain) {
    return errorResponse(403, "FIXTURE_RECIPIENT_DENIED", "Controlled fixture email can be sent only to the configured Maintain Flow inbound domain.")
  }
  if (input.scenario === "captcha-blocked") return errorResponse(409, "CAPTCHA_BLOCKED", "The controlled CAPTCHA blocks this submission.")
  if (input.scenario === "failed-lead") return errorResponse(422, "BUSINESS_ASSERTION_FAILED", "Fixture lead submission failed")

  const shouldSendEmail = !["missing-email"].includes(input.scenario)
  if (shouldSendEmail) {
    if (input.scenario === "delayed-email") await new Promise((resolve) => setTimeout(resolve, 6_000))
    const trial = ["healthy-trial", "cleanup-failure", "malicious-link"].includes(input.scenario)
    const token = createControlledFixtureToken({ scenario: input.scenario, marker })
    const safeLink = new URL(`/business-evals-fixtures/verify?token=${encodeURIComponent(token)}`, fixtureOrigin(request)).toString()
    const verificationLink = input.scenario === "malicious-link" ? `https://attacker.invalid/verify?token=${encodeURIComponent(token)}` : safeLink
    try {
      await sendFixtureEmail({
        to: input.email,
        marker,
        trial,
        verificationLink,
        idempotencyKey: `fixture:${createHash("sha256").update(`${input.scenario}:${marker}:${input.email.toLowerCase()}`).digest("hex")}`,
      })
    } catch {
      return errorResponse(503, "FIXTURE_EMAIL_UNAVAILABLE", "Controlled fixture email delivery is unavailable.")
    }
  }

  return NextResponse.json({
    ok: true,
    data: { message: ["healthy-trial", "cleanup-failure", "malicious-link"].includes(input.scenario) ? "Verification email queued" : "Lead received" },
  })
}

async function sendFixtureEmail(input: { to: string; marker: string; trial: boolean; verificationLink: string; idempotencyKey: string }) {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? ""
  const from = process.env.BUSINESS_EVALS_FIXTURE_FROM_EMAIL?.trim() || process.env.MAINTAINFLOW_ALERT_FROM_EMAIL?.trim() || ""
  if (!apiKey || !from) throw new Error("Controlled fixture email delivery is not configured.")
  const body = input.trial
    ? `${input.marker}\n\nVerify email: ${input.verificationLink}`
    : `${input.marker}\n\nYour controlled fixture lead was received.`
  const response = await new Resend(apiKey).emails.send({
    from,
    to: [input.to],
    subject: `Maintain Flow controlled fixture ${input.marker}`,
    text: body,
    html: input.trial
      ? `<p>${input.marker}</p><p><a href="${escapeHtml(input.verificationLink)}">Verify email</a></p>`
      : `<p>${input.marker}</p><p>Your controlled fixture lead was received.</p>`,
  }, { idempotencyKey: input.idempotencyKey })
  if (response.error) throw new Error("The controlled fixture email provider rejected the delivery.")
}

function exactSyntheticMarker(value: string) {
  return value.match(/(?:^|\s)(MF-EVAL-[A-Z0-9-]{8,120})(?=$|\s)/)?.[1] ?? null
}

function recipientDomain(value: string) {
  return value.trim().toLowerCase().split("@").at(-1) ?? ""
}

function fixtureOrigin(request: NextRequest) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim()
  const origin = configured ? new URL(configured).origin : request.nextUrl.origin
  if (process.env.NODE_ENV === "production" && !origin.startsWith("https://")) throw new Error("Controlled production fixtures require an HTTPS origin.")
  return origin
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status })
}
