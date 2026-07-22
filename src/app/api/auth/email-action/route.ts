import { NextRequest, NextResponse } from "next/server"

import { createFixedWindowRateLimiter } from "@/lib/core/rate-limit"
import { safeServerLog } from "@/lib/observability/safe-server-log"
import {
  EmailActionRequestError,
  parseEmailActionRequest,
} from "@/lib/supabase/email-action-request"
import {
  completeServerEmailAction,
  EmailActionServerError,
} from "@/lib/supabase/email-actions.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const sourceLimiter = createFixedWindowRateLimiter({ limit: 30, windowMs: 5 * 60_000 })
const processLimiter = createFixedWindowRateLimiter({ limit: 300, windowMs: 5 * 60_000 })

export async function POST(request: NextRequest) {
  try {
    const input = await parseEmailActionRequest(request)
    if (
      !processLimiter.check("all-email-actions").allowed
      || !sourceLimiter.check(requestSourceKey(request)).allowed
    ) {
      return errorResponse(429, "RATE_LIMITED", "Too many email-action attempts. Wait before trying again.")
    }

    const data = await completeServerEmailAction(input)
    return NextResponse.json({ ok: true, data }, { headers: noStoreHeaders() })
  } catch (error) {
    if (error instanceof EmailActionRequestError) {
      return errorResponse(error.status, error.code, error.message)
    }
    if (error instanceof EmailActionServerError) {
      return errorResponse(error.status, error.code, error.message)
    }

    safeServerLog("error", "auth-email-action-failed", { reference: crypto.randomUUID() })
    return errorResponse(500, "EMAIL_ACTION_FAILED", "This email action could not be completed safely. Request a new link.")
  }
}

function requestSourceKey(request: NextRequest) {
  const candidate = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? ""
  return /^[A-Fa-f0-9:.]{3,64}$/.test(candidate) ? candidate : "unknown-source"
}

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status, headers: noStoreHeaders() },
  )
}

function noStoreHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  }
}
