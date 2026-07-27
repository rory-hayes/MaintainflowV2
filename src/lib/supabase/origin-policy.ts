export const MAINTAINFLOW_SUPABASE_AUTH_ORIGIN = "https://auth.maintainflow.io"

export function isApprovedSupabaseOriginSet(input: {
  supabaseUrl: string
  authUrl: string
  expectedProjectRef?: string
  nodeEnv?: string
}) {
  const projectOrigin = baseHttpsOrigin(input.supabaseUrl)
  const authOrigin = baseHttpsOrigin(input.authUrl)
  if (!projectOrigin || !authOrigin) return false

  if (input.nodeEnv !== "production") return true

  const projectRef = input.expectedProjectRef?.trim() ?? ""
  if (!/^[a-z0-9]{10,40}$/.test(projectRef)) return false
  if (projectOrigin !== `https://${projectRef}.supabase.co`) return false
  return authOrigin === projectOrigin || authOrigin === MAINTAINFLOW_SUPABASE_AUTH_ORIGIN
}

export function baseHttpsOrigin(value: string | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
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
