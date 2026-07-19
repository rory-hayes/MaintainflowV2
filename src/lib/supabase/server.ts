import "server-only"

type SupabaseRequestInit = RequestInit & {
  prefer?: string
}

export function getSupabaseServerConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "") ?? ""
  const authUrl = process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL?.replace(/\/+$/, "") || supabaseUrl
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""

  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.")
  }

  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.")
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
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
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
