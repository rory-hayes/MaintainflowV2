"use client"

export const SUPABASE_SESSION_KEY = "maintain-flow-supabase-session"

export function getSupabaseConfig() {
  if (process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE === "local") {
    return {
      enabled: false,
      supabaseUrl: "",
      authUrl: "",
      anonKey: "",
      restUrl: "",
    }
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const authUrl = process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL?.replace(/\/+$/, "") || supabaseUrl
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""

  return {
    enabled: Boolean(supabaseUrl && anonKey),
    supabaseUrl,
    authUrl,
    anonKey,
    restUrl: `${supabaseUrl}/rest/v1`,
  }
}

export function isEmailPasswordAuthEnabled() {
  return true
}
