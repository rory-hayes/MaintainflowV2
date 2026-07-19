import "server-only"

import { hashRateLimitKey } from "@/lib/ops/rate-limit-events.shared"
import { supabaseServiceJson } from "@/lib/supabase/server"

export async function recordRateLimitEvent(input: {
  scope: string
  key: string
  userId?: string | null
  agencyId?: string | null
  allowed: boolean
  remaining: number
  resetAt: string
  metadata?: Record<string, string | number | boolean | null>
}) {
  await supabaseServiceJson("rate_limit_events", {
    method: "POST",
    body: JSON.stringify({
      agency_id: input.agencyId ?? null,
      user_id: input.userId ?? null,
      scope: input.scope,
      key_hash: hashRateLimitKey(input.scope, input.key, process.env.RUN_LOG_KEY_PEPPER ?? ""),
      allowed: input.allowed,
      remaining: input.remaining,
      reset_at: input.resetAt,
      metadata_json: input.metadata ?? {},
    }),
  }).catch(() => undefined)
}
