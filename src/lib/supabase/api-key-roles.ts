export type SupabaseApiKeyRole = "publishable" | "secret" | "anon" | "service_role" | "unknown"

const OPAQUE_KEY_BODY = "[A-Za-z0-9_-]{16,}"
const PUBLISHABLE_KEY = new RegExp(`^sb_publishable_${OPAQUE_KEY_BODY}$`)
const SECRET_KEY = new RegExp(`^sb_secret_${OPAQUE_KEY_BODY}$`)

export function supabaseApiKeyRole(value: string | undefined): SupabaseApiKeyRole {
  const key = value?.trim() ?? ""
  if (PUBLISHABLE_KEY.test(key)) return "publishable"
  if (SECRET_KEY.test(key)) return "secret"
  return legacyJwtRole(key)
}

export function isSupabasePublicApiKey(value: string | undefined) {
  const role = supabaseApiKeyRole(value)
  return role === "publishable" || role === "anon"
}

export function isSupabaseServiceApiKey(value: string | undefined) {
  const role = supabaseApiKeyRole(value)
  return role === "secret" || role === "service_role"
}

export function isModernSupabasePublicApiKey(value: string | undefined) {
  return supabaseApiKeyRole(value) === "publishable"
}

export function isModernSupabaseServiceApiKey(value: string | undefined) {
  return supabaseApiKeyRole(value) === "secret"
}

export function supabaseServiceAuthHeaders(serviceKey: string) {
  if (!isSupabaseServiceApiKey(serviceKey)) {
    throw new Error("The Supabase server API key does not have service privileges.")
  }
  return {
    apikey: serviceKey,
    ...(supabaseApiKeyRole(serviceKey) === "service_role"
      ? { Authorization: `Bearer ${serviceKey}` }
      : {}),
  }
}

function legacyJwtRole(value: string): SupabaseApiKeyRole {
  const parts = value.split(".")
  if (parts.length !== 3 || !parts[1]) return "unknown"
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { role?: unknown }
    return payload.role === "anon"
      ? "anon"
      : payload.role === "service_role"
        ? "service_role"
        : "unknown"
  } catch {
    return "unknown"
  }
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  return globalThis.atob(padded)
}
