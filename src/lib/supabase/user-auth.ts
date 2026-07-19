type SupabaseAuthEnv = Partial<Record<
  | "NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_AUTH_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  string
>>

type SupabaseUser = {
  id?: string
  email?: string
  msg?: string
  error?: string
}

export type SupabaseUserAuthConfig = ReturnType<typeof getSupabaseUserAuthConfig>

export function getSupabaseUserAuthConfig(env?: SupabaseAuthEnv) {
  const source = env ?? process.env
  const supabaseUrl = source.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const authUrl = source.NEXT_PUBLIC_SUPABASE_AUTH_URL?.replace(/\/+$/, "") || supabaseUrl
  const anonKey = source.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  const enabled = source.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE !== "local" && Boolean(supabaseUrl && anonKey)

  return {
    enabled,
    supabaseUrl,
    authUrl,
    anonKey,
  }
}

export async function verifySupabaseAccessToken(
  token: string,
  config: SupabaseUserAuthConfig = getSupabaseUserAuthConfig(),
  fetchImpl: typeof fetch = fetch
) {
  if (!config.enabled) {
    throw new Error("Supabase auth is not configured.")
  }

  const response = await fetchImpl(`${config.authUrl}/auth/v1/user`, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${token}`,
    },
  })
  const user = (await response.json().catch(() => ({}))) as SupabaseUser

  if (!response.ok || !user.id) {
    throw new Error(user.msg || user.error || "Sign in again before testing an endpoint.")
  }

  return {
    id: user.id,
    email: user.email ?? "",
  }
}
