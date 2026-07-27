import { isSupabasePublicApiKey } from "./api-key-roles.ts"
import { isApprovedSupabaseOriginSet } from "./origin-policy.ts"

type SupabaseAuthEnv = Partial<Record<
  | "NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_AUTH_URL"
  | "NEXT_PUBLIC_SUPABASE_PROJECT_REF"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  string
>>

type SupabaseUser = {
  id?: string
  email?: string
  msg?: string
  error?: string
}

type AccountActivationStatus = {
  activation_required?: boolean
  activation_complete?: boolean
}

export class SupabaseAccountActivationError extends Error {
  constructor(message = "Confirm your email from the Maintain Flow link before signing in.") {
    super(message)
    this.name = "SupabaseAccountActivationError"
  }
}

export type SupabaseUserAuthConfig = ReturnType<typeof getSupabaseUserAuthConfig>

export function getSupabaseUserAuthConfig(env?: SupabaseAuthEnv) {
  const source = env ?? process.env
  const supabaseUrl = source.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const authUrl = source.NEXT_PUBLIC_SUPABASE_AUTH_URL?.replace(/\/+$/, "") || supabaseUrl
  const anonKey = source.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  const enabled = source.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE !== "local" && Boolean(
    isSupabasePublicApiKey(anonKey)
    && isApprovedSupabaseOriginSet({
      supabaseUrl,
      authUrl,
      expectedProjectRef: source.NEXT_PUBLIC_SUPABASE_PROJECT_REF,
      nodeEnv: process.env.NODE_ENV,
    })
  )

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

  await requireSupabaseAccountActivation(token, config, fetchImpl)

  return {
    id: user.id,
    email: user.email ?? "",
  }
}

export async function requireSupabaseAccountActivation(
  token: string,
  config: SupabaseUserAuthConfig = getSupabaseUserAuthConfig(),
  fetchImpl: typeof fetch = fetch
) {
  if (!config.enabled) {
    throw new Error("Supabase auth is not configured.")
  }

  let response: Response
  try {
    response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/current_auth_account_activation_status`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    })
  } catch {
    throw new Error("Account activation could not be verified. Try again before continuing.")
  }

  const payload = (await response.json().catch(() => null)) as AccountActivationStatus[] | null
  const status = payload?.[0]
  if (!response.ok || !status || typeof status.activation_complete !== "boolean") {
    throw new Error("Account activation could not be verified. Try again before continuing.")
  }
  if (status.activation_required === true && status.activation_complete !== true) {
    throw new SupabaseAccountActivationError()
  }

  return {
    required: status.activation_required === true,
    complete: status.activation_complete === true,
  }
}
