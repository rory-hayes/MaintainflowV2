import "server-only"

import { createHash } from "node:crypto"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { supabaseServiceJson } from "@/lib/supabase/server"

type RateLimitRow = {
  allowed?: boolean
  remaining?: number
  reset_at?: string
}

export async function enforceBusinessEvalRateLimits(input: {
  userId: string
  workspaceId: string
  projectId: string
  destinationDomain: string
}) {
  const checks = await Promise.all([
    consumeRateLimit("user", input.userId, 30),
    consumeRateLimit("workspace", input.workspaceId, 120),
    consumeRateLimit("project", input.projectId, 40),
    consumeRateLimit("destination_domain", input.destinationDomain.toLowerCase(), 20),
  ])
  const blocked = checks.find((result) => !result.allowed)
  if (blocked) {
    throw new BusinessEvalsApiError(
      429,
      "RATE_LIMITED",
      `The ${blocked.label} safety limit was reached. Try again after ${blocked.resetAt}.`
    )
  }
}

/**
 * Applies the shared destination-domain ceiling at the last responsible
 * moment for a runner destination. This is intentionally separate from the
 * enqueue limits: form actions and email verification redirects are not
 * always known until the immutable run is executing.
 */
export async function enforceBusinessEvalDestinationRateLimit(destinationDomain: string) {
  const result = await consumeRateLimit("destination_domain", destinationDomain, 20)
  if (!result.allowed) {
    throw new BusinessEvalsApiError(
      429,
      "RATE_LIMITED",
      `The destination domain safety limit was reached. Try again after ${result.resetAt}.`
    )
  }
}

export async function enforceBusinessEvalAiRateLimits(input: {
  userId: string
  workspaceId: string
  projectId: string
}) {
  const checks = await Promise.all([
    consumeRateLimit("ai_user", input.userId, 6),
    consumeRateLimit("ai_workspace", input.workspaceId, 30),
    consumeRateLimit("ai_project", input.projectId, 12),
  ])
  const blocked = checks.find((result) => !result.allowed)
  if (blocked) {
    throw new BusinessEvalsApiError(
      429,
      "AI_RATE_LIMITED",
      `The ${blocked.label} AI-assistance limit was reached. Try again after ${blocked.resetAt}.`
    )
  }
}

async function consumeRateLimit(
  scope: "user" | "workspace" | "project" | "destination_domain" | "ai_user" | "ai_workspace" | "ai_project",
  rawKey: string,
  limit: number
) {
  const normalizedKey = rawKey.trim().toLowerCase()
  if (!normalizedKey) throw new Error(`The ${scope} rate-limit key is missing.`)
  const rows = await supabaseServiceJson<RateLimitRow[]>("rpc/consume_business_eval_rate_limit", {
    method: "POST",
    body: JSON.stringify({
      p_scope_type: scope,
      p_scope_key_hash: createHash("sha256").update(`business-evals:${scope}:${normalizedKey}`).digest("hex"),
      p_limit: limit,
      p_window_seconds: 60,
    }),
  })
  const row = rows[0]
  if (!row || typeof row.allowed !== "boolean" || typeof row.reset_at !== "string") {
    throw new Error("The persistent business-eval rate limiter returned an invalid result.")
  }
  return {
    label: scope === "destination_domain"
      ? "destination domain"
      : scope.startsWith("ai_")
        ? scope.slice(3)
        : scope,
    allowed: row.allowed,
    resetAt: new Date(row.reset_at).toISOString(),
  }
}
