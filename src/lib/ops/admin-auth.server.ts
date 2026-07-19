import { bearerToken } from "../supabase/report-download.server.ts"
import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "../supabase/user-auth.ts"

type OpsAdminEnv = Record<string, string | undefined>

export type OpsAdminAuthResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; status: 401 | 403 | 503; message: string }

export function getOpsAdminEmails(env: OpsAdminEnv = process.env) {
  return new Set(
    String(env.OPS_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  )
}

export async function authorizeOpsRequest(
  authorizationHeader: string | null,
  {
    env = process.env,
    fetchImpl = fetch,
  }: {
    env?: OpsAdminEnv
    fetchImpl?: typeof fetch
  } = {}
): Promise<OpsAdminAuthResult> {
  const allowedEmails = getOpsAdminEmails(env)
  if (!allowedEmails.size) {
    return {
      ok: false,
      status: 403,
      message: "OPS_ADMIN_EMAILS is not configured.",
    }
  }

  const token = bearerToken(authorizationHeader)
  if (!token) {
    return {
      ok: false,
      status: 401,
      message: "Sign in before opening the ops console.",
    }
  }

  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    return {
      ok: false,
      status: 503,
      message: "Supabase auth is required for the ops console.",
    }
  }

  try {
    const user = await verifySupabaseAccessToken(token, config, fetchImpl)
    if (!allowedEmails.has(user.email.toLowerCase())) {
      return {
        ok: false,
        status: 403,
        message: "This user is not allowed to open the ops console.",
      }
    }

    return { ok: true, user }
  } catch (error) {
    return {
      ok: false,
      status: 401,
      message: error instanceof Error ? error.message : "Sign in again before opening the ops console.",
    }
  }
}
