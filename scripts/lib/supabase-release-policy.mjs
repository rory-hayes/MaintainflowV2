const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{16,}$/
const SECRET_KEY = /^sb_secret_[A-Za-z0-9_-]{16,}$/
const PROJECT_REF = /^[a-z0-9]{10,40}$/

export const maintainFlowAuthOrigin = "https://auth.maintainflow.io"

export function validateProductionSupabaseConnection(values) {
  const projectRef = String(values.NEXT_PUBLIC_SUPABASE_PROJECT_REF || "").trim()
  if (!PROJECT_REF.test(projectRef)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PROJECT_REF must be the exact 10-40 character Supabase project reference.")
  }

  const projectOrigin = exactHttpsBaseOrigin(values.NEXT_PUBLIC_SUPABASE_URL)
  const expectedProjectOrigin = `https://${projectRef}.supabase.co`
  if (projectOrigin !== expectedProjectOrigin) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must exactly match the approved Supabase project reference.")
  }

  const authOrigin = exactHttpsBaseOrigin(values.NEXT_PUBLIC_SUPABASE_AUTH_URL || projectOrigin)
  if (authOrigin !== projectOrigin && authOrigin !== maintainFlowAuthOrigin) {
    throw new Error(`NEXT_PUBLIC_SUPABASE_AUTH_URL must be the approved project origin or ${maintainFlowAuthOrigin}.`)
  }

  const publicKey = String(values.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim()
  const serviceKey = String(values.SUPABASE_SERVICE_ROLE_KEY || "").trim()
  if (!PUBLISHABLE_KEY.test(publicKey)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY must be a modern sb_publishable_ browser-safe key.")
  }
  if (!SECRET_KEY.test(serviceKey)) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be a modern sb_secret_ server-only key.")
  }
  if (publicKey === serviceKey) {
    throw new Error("The Supabase public and server-only keys must be different.")
  }

  return { projectRef, projectOrigin, authOrigin, publicKey, serviceKey }
}

export function supabaseServiceHeaders(serviceKey) {
  const normalized = String(serviceKey || "").trim()
  if (SECRET_KEY.test(normalized)) return { apikey: normalized }
  if (legacyJwtRole(normalized) === "service_role") {
    return { apikey: normalized, Authorization: `Bearer ${normalized}` }
  }
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a Supabase server-only key.")
}

function exactHttpsBaseOrigin(value) {
  try {
    const url = new URL(String(value || "").trim())
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")
    ) return null
    return url.origin
  } catch {
    return null
  }
}

function legacyJwtRole(value) {
  const parts = value.split(".")
  if (parts.length !== 3 || !parts[1]) return "unknown"
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role || "unknown"
  } catch {
    return "unknown"
  }
}
