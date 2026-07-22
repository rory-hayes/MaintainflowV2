import "server-only"

import {
  isSupabasePublicApiKey,
  isSupabaseServiceApiKey,
  supabaseServiceAuthHeaders,
} from "./api-key-roles.ts"
import { isApprovedSupabaseOriginSet } from "./origin-policy.ts"

type SupabaseRequestInit = RequestInit & {
  prefer?: string
}

export function getSupabaseServerConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const authUrl = process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL?.replace(/\/+$/, "") || supabaseUrl
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? ""
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  const expectedProjectRef = process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF?.trim() ?? ""

  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.")
  }

  if (!isApprovedSupabaseOriginSet({
    supabaseUrl,
    authUrl,
    expectedProjectRef,
    nodeEnv: process.env.NODE_ENV,
  })) {
    throw new Error("The configured Supabase project and Auth origins are not approved.")
  }

  if (!isSupabaseServiceApiKey(serviceRoleKey)) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a server-only Supabase service key.")
  }

  if (publicKey && !isSupabasePublicApiKey(publicKey)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not a browser-safe Supabase public key.")
  }

  if (publicKey && publicKey === serviceRoleKey.trim()) {
    throw new Error("Supabase public and service keys must be different.")
  }

  return {
    supabaseUrl,
    authUrl,
    serviceRoleKey,
    restUrl: `${supabaseUrl}/rest/v1`,
  }
}

export async function supabaseServiceJson<T>(path: string, init: SupabaseRequestInit = {}) {
  const config = getSupabaseServerConfig()
  const response = await fetch(`${config.restUrl}/${path}`, {
    ...init,
    headers: {
      ...supabaseServiceAuthHeaders(config.serviceRoleKey),
      "Content-Type": "application/json",
      Prefer: init.prefer ?? "return=representation",
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null

  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.hint === "string"
          ? payload.hint
          : "Supabase service request failed."
    throw new Error(message)
  }

  return payload as T
}
