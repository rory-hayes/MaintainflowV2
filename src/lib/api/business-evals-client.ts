"use client"

import { type z, type ZodType } from "zod"

import {
  parseBusinessEvalsResponsePayload,
} from "@/lib/api/business-evals-response-schemas"
import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"

export type ApiEnvelope<T> = {
  ok: true
  data: T
  meta?: { nextCursor?: string | null; total?: number }
}

export class BusinessEvalsClientError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "BusinessEvalsClientError"
    this.status = status
    this.code = code
  }
}

export async function businessEvalsRequest<TSchema extends ZodType>(
  path: string,
  dataSchema: TSchema,
  init: RequestInit & { workspaceId?: string; idempotencyKey?: string } = {}
): Promise<ApiEnvelope<z.infer<TSchema>>> {
  const token = await getValidSupabaseAccessToken()
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  if (token) headers.set("Authorization", `Bearer ${token}`)
  if (init.workspaceId) headers.set("X-MaintainFlow-Workspace-Id", init.workspaceId)
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey)

  const response = await fetch(path, { ...init, headers, cache: "no-store" })
  const payload: unknown = await response.json().catch(() => null)
  const parsed = parseBusinessEvalsResponsePayload(payload, dataSchema)

  if (!response.ok || parsed?.ok === false) {
    if (!parsed || parsed.ok) {
      throw invalidResponseError(response.status)
    }
    throw new BusinessEvalsClientError(
      response.status,
      parsed.error.code,
      parsed.error.message
    )
  }

  if (!parsed) throw invalidResponseError(response.status)
  return parsed
}

export function createIdempotencyKey(scope: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${scope}:${random}`
}

function invalidResponseError(status: number) {
  return new BusinessEvalsClientError(
    status,
    "INVALID_RESPONSE",
    "Maintain Flow received an unexpected API response. Refresh and try again."
  )
}
