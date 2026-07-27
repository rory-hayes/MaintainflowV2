"use client"

import { isSupabasePublicApiKey } from "./api-key-roles.ts"
import { isApprovedSupabaseOriginSet } from "./origin-policy.ts"

export const SUPABASE_SESSION_KEY = "maintain-flow-supabase-session"

type PublicAuthEnv = Partial<Record<
  | "NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_AUTH_URL"
  | "NEXT_PUBLIC_SUPABASE_PROJECT_REF"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  string | undefined
>>

export function getSupabaseConfig(
  source?: PublicAuthEnv,
  nodeEnv = process.env.NODE_ENV
) {
  const values: PublicAuthEnv = source ?? {
    NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE: process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_AUTH_URL: process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL,
    NEXT_PUBLIC_SUPABASE_PROJECT_REF: process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }
  const localRequested = values.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE === "local"
  const supabaseUrl = values.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const authUrl = values.NEXT_PUBLIC_SUPABASE_AUTH_URL?.replace(/\/+$/, "") || supabaseUrl
  const anonKey = values.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  const enabled = !localRequested && Boolean(
    isSupabasePublicApiKey(anonKey)
    && isApprovedSupabaseOriginSet({
      supabaseUrl,
      authUrl,
      expectedProjectRef: values.NEXT_PUBLIC_SUPABASE_PROJECT_REF,
      nodeEnv,
    })
  )
  // Local/demo auth is a development fixture, never a production fallback.
  // A production configuration mistake must leave authentication unavailable
  // instead of silently creating a browser-local user.
  const localEnabled = nodeEnv !== "production" && !enabled

  return {
    enabled,
    localEnabled,
    supabaseUrl,
    authUrl,
    anonKey,
    restUrl: `${supabaseUrl}/rest/v1`,
  }
}

export function isEmailPasswordAuthEnabled() {
  return true
}
