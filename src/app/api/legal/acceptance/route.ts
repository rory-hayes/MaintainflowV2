import { createHash } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import {
  MAINTAINFLOW_PRIVACY_VERSION,
  MAINTAINFLOW_TERMS_VERSION,
} from "@/lib/legal/acceptance"
import { bearerToken } from "@/lib/supabase/report-download.server"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "@/lib/supabase/user-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const legalAcceptanceSchema = z.object({
  accepted: z.literal(true),
  termsVersion: z.literal(MAINTAINFLOW_TERMS_VERSION),
  privacyVersion: z.literal(MAINTAINFLOW_PRIVACY_VERSION),
  source: z.enum(["oauth_callback", "password_reset"]),
}).strict()

type LegalAcceptanceRow = {
  acceptance_id?: string
  id?: string
  accepted_at: string
  terms_version: string
  privacy_version: string
  source: string
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuthenticatedUser(request)
    const params = new URLSearchParams({
      select: "id,accepted_at,terms_version,privacy_version,source",
      user_id: `eq.${user.id}`,
      terms_version: `eq.${MAINTAINFLOW_TERMS_VERSION}`,
      privacy_version: `eq.${MAINTAINFLOW_PRIVACY_VERSION}`,
      limit: "1",
    })
    const rows = await supabaseServiceJson<LegalAcceptanceRow[]>(`legal_acceptances?${params.toString()}`)
    const acceptance = rows[0]

    return NextResponse.json({
      ok: true,
      data: {
        accepted: Boolean(acceptance?.id),
        termsVersion: MAINTAINFLOW_TERMS_VERSION,
        privacyVersion: MAINTAINFLOW_PRIVACY_VERSION,
        acceptedAt: acceptance?.accepted_at ?? null,
      },
    }, { headers: noStoreHeaders() })
  } catch (error) {
    return legalAcceptanceErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuthenticatedUser(request)
    const contentLength = Number(request.headers.get("content-length") ?? "0")
    if (Number.isFinite(contentLength) && contentLength > 4096) {
      throw new LegalAcceptanceApiError(413, "REQUEST_TOO_LARGE", "The legal-acceptance request was too large.")
    }

    const rawBody = await request.text().catch(() => "")
    if (Buffer.byteLength(rawBody, "utf8") > 4096) {
      throw new LegalAcceptanceApiError(413, "REQUEST_TOO_LARGE", "The legal-acceptance request was too large.")
    }
    let body: unknown = null
    try {
      body = JSON.parse(rawBody)
    } catch {
      // The strict schema below returns the same safe acceptance error.
    }
    const input = legalAcceptanceSchema.safeParse(body)
    if (!input.success) {
      throw new LegalAcceptanceApiError(
        400,
        "LEGAL_ACCEPTANCE_REQUIRED",
        "Accept the current Terms and acknowledge the Privacy Policy before continuing."
      )
    }

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? ""
    if (!/^[A-Za-z0-9:_-]{16,200}$/.test(idempotencyKey)) {
      throw new LegalAcceptanceApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Restart this account action so the acceptance can be recorded safely."
      )
    }

    const rows = await supabaseServiceJson<LegalAcceptanceRow[]>("rpc/record_current_legal_acceptance", {
      method: "POST",
      body: JSON.stringify({
        p_user_id: user.id,
        p_terms_version: input.data.termsVersion,
        p_privacy_version: input.data.privacyVersion,
        p_source: input.data.source,
        p_idempotency_key_hash: createHash("sha256").update(idempotencyKey).digest("hex"),
      }),
    })
    const acceptance = rows[0]
    if (!acceptance?.acceptance_id || acceptance.terms_version !== MAINTAINFLOW_TERMS_VERSION
      || acceptance.privacy_version !== MAINTAINFLOW_PRIVACY_VERSION) {
      throw new Error("The legal acceptance was not durably recorded.")
    }

    return NextResponse.json({
      ok: true,
      data: {
        accepted: true,
        termsVersion: acceptance.terms_version,
        privacyVersion: acceptance.privacy_version,
        acceptedAt: acceptance.accepted_at,
      },
    }, { headers: noStoreHeaders() })
  } catch (error) {
    return legalAcceptanceErrorResponse(error)
  }
}

async function requireAuthenticatedUser(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    throw new LegalAcceptanceApiError(401, "AUTH_REQUIRED", "Sign in again before recording legal acceptance.")
  }

  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    throw new LegalAcceptanceApiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured.")
  }

  try {
    return await verifySupabaseAccessToken(token, config)
  } catch {
    throw new LegalAcceptanceApiError(401, "INVALID_SESSION", "Sign in again before recording legal acceptance.")
  }
}

class LegalAcceptanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "LegalAcceptanceApiError"
  }
}

function legalAcceptanceErrorResponse(error: unknown) {
  if (error instanceof LegalAcceptanceApiError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.status, headers: noStoreHeaders() }
    )
  }

  console.error("[legal-acceptance-api] Legal acceptance could not be recorded.")
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "LEGAL_ACCEPTANCE_NOT_RECORDED",
        message: "Your account was not opened because the legal acceptance could not be recorded. Start again.",
      },
    },
    { status: 500, headers: noStoreHeaders() }
  )
}

function noStoreHeaders() {
  return { "Cache-Control": "private, no-store" }
}
