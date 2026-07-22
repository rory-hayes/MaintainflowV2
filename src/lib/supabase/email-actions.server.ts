import "server-only"

import { createHash } from "node:crypto"

import {
  MAINTAINFLOW_PRIVACY_VERSION,
  MAINTAINFLOW_TERMS_VERSION,
  type CurrentLegalAcceptance,
} from "../legal/acceptance.ts"
import { safeServerLog } from "../observability/safe-server-log.ts"
import {
  completeEmailActionWithDependencies,
  EmailActionRevocationError,
  type EmailActionOrchestrationInput,
  type VerifiedEmailActionSession,
} from "./email-action-orchestration.ts"
import { supabaseServiceJson } from "./server.ts"
import { getSupabaseUserAuthConfig } from "./user-auth.ts"

type AuthResponse = {
  access_token?: string
  user?: { id?: string }
  id?: string
}

type LegalAcceptanceRow = {
  id?: string
  acceptance_id?: string
  accepted_at?: string
  terms_version?: string
  privacy_version?: string
}

type AccountActivationRow = {
  activation_required?: boolean
  activated_at?: string | null
}

export class EmailActionServerError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "EmailActionServerError"
    this.status = status
    this.code = code
  }
}

export async function completeServerEmailAction(action: EmailActionOrchestrationInput) {
  try {
    return await completeEmailActionWithDependencies(action, {
      verify: verifyTokenHash,
      requireSignupLegalAcceptance,
      activateSignupAccount,
      recordRecoveryLegalAcceptance,
      updatePassword,
      revoke: revokeTemporarySession,
    })
  } catch (error) {
    if (error instanceof EmailActionRevocationError) {
      safeServerLog("error", "auth-email-action-revoke-failed", { actionType: action.type })
      throw new EmailActionServerError(
        502,
        "TEMPORARY_SESSION_NOT_REVOKED",
        action.type === "email"
          ? "The email was verified, but session cleanup could not be confirmed. Contact support before signing in."
          : "The password action could not be completed safely. Request a new reset link before signing in.",
      )
    }
    throw error
  }
}

async function activateSignupAccount(userId: string) {
  let rows: AccountActivationRow[]
  try {
    rows = await supabaseServiceJson<AccountActivationRow[]>("rpc/activate_email_signup_account", {
      method: "POST",
      body: JSON.stringify({ p_user_id: userId }),
    })
  } catch {
    throw new EmailActionServerError(
      503,
      "ACCOUNT_ACTIVATION_UNAVAILABLE",
      "Your email was verified, but account activation could not be recorded. Contact support before signing in.",
    )
  }

  const activation = rows[0]
  if (activation?.activation_required === true && !activation.activated_at) {
    throw new EmailActionServerError(
      503,
      "ACCOUNT_ACTIVATION_NOT_RECORDED",
      "Your email was verified, but account activation could not be recorded. Contact support before signing in.",
    )
  }
}

async function verifyTokenHash(type: EmailActionOrchestrationInput["type"], tokenHash: string): Promise<VerifiedEmailActionSession> {
  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    throw new EmailActionServerError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured.")
  }

  let response: Response
  try {
    response = await fetch(`${config.authUrl}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type, token_hash: tokenHash }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new EmailActionServerError(502, "AUTH_PROVIDER_UNAVAILABLE", "Authentication is temporarily unavailable. Try again.")
  }

  const payload = (await response.json().catch(() => null)) as AuthResponse | null
  if (!response.ok) {
    if (response.status === 429) {
      throw new EmailActionServerError(429, "AUTH_RATE_LIMITED", "Too many attempts. Wait a moment and request a new link.")
    }
    if ([400, 401, 403, 404, 422].includes(response.status)) {
      throw invalidLinkError(type)
    }
    throw new EmailActionServerError(502, "AUTH_PROVIDER_FAILURE", "Authentication is temporarily unavailable. Try again.")
  }

  if (!payload?.access_token || !payload.user?.id) {
    throw new EmailActionServerError(502, "AUTH_RESPONSE_INCOMPLETE", "Authentication returned an incomplete response. Request a new link.")
  }

  return { accessToken: payload.access_token, userId: payload.user.id }
}

async function requireSignupLegalAcceptance(userId: string) {
  const params = new URLSearchParams({
    select: "id,accepted_at,terms_version,privacy_version",
    user_id: `eq.${userId}`,
    terms_version: `eq.${MAINTAINFLOW_TERMS_VERSION}`,
    privacy_version: `eq.${MAINTAINFLOW_PRIVACY_VERSION}`,
    limit: "1",
  })

  let rows: LegalAcceptanceRow[]
  try {
    rows = await supabaseServiceJson<LegalAcceptanceRow[]>(`legal_acceptances?${params.toString()}`)
  } catch {
    throw new EmailActionServerError(
      503,
      "LEGAL_ACCEPTANCE_UNAVAILABLE",
      "Your email was verified, but the current Terms and Privacy acceptance could not be checked. Contact support before signing in.",
    )
  }

  const acceptance = rows[0]
  if (
    !acceptance?.id
    || !acceptance.accepted_at
    || acceptance.terms_version !== MAINTAINFLOW_TERMS_VERSION
    || acceptance.privacy_version !== MAINTAINFLOW_PRIVACY_VERSION
  ) {
    throw new EmailActionServerError(
      409,
      "LEGAL_ACCEPTANCE_REQUIRED",
      "Your email was verified, but the current Terms and Privacy acceptance was not recorded. Contact support before signing in.",
    )
  }
}

async function recordRecoveryLegalAcceptance(
  userId: string,
  tokenHash: string,
  acceptance: CurrentLegalAcceptance,
) {
  let rows: LegalAcceptanceRow[]
  try {
    rows = await supabaseServiceJson<LegalAcceptanceRow[]>("rpc/record_current_legal_acceptance", {
      method: "POST",
      body: JSON.stringify({
        p_user_id: userId,
        p_terms_version: acceptance.termsVersion,
        p_privacy_version: acceptance.privacyVersion,
        p_source: acceptance.source,
        p_idempotency_key_hash: createHash("sha256")
          .update(`password-reset:${tokenHash}`)
          .digest("hex"),
      }),
    })
  } catch {
    throw new EmailActionServerError(
      503,
      "LEGAL_ACCEPTANCE_NOT_RECORDED",
      "The current Terms and Privacy acceptance could not be recorded. Request a new reset link and try again.",
    )
  }

  const recorded = rows[0]
  if (
    !recorded?.acceptance_id
    || !recorded.accepted_at
    || recorded.terms_version !== MAINTAINFLOW_TERMS_VERSION
    || recorded.privacy_version !== MAINTAINFLOW_PRIVACY_VERSION
  ) {
    throw new EmailActionServerError(
      500,
      "LEGAL_ACCEPTANCE_NOT_RECORDED",
      "The current Terms and Privacy acceptance could not be recorded. Request a new reset link and try again.",
    )
  }
}

async function updatePassword(session: VerifiedEmailActionSession, password: string) {
  const config = getSupabaseUserAuthConfig()
  let response: Response
  try {
    response = await fetch(`${config.authUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new EmailActionServerError(502, "PASSWORD_UPDATE_FAILED", "The password could not be updated. Request a new reset link.")
  }

  const payload = (await response.json().catch(() => null)) as AuthResponse | null
  const returnedUserId = payload?.user?.id ?? payload?.id
  if (!response.ok || returnedUserId !== session.userId) {
    throw new EmailActionServerError(502, "PASSWORD_UPDATE_FAILED", "The password could not be updated. Request a new reset link.")
  }
}

async function revokeTemporarySession(accessToken: string) {
  const config = getSupabaseUserAuthConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error("Supabase did not revoke the temporary email-action session.")
  }
}

function invalidLinkError(type: EmailActionOrchestrationInput["type"]) {
  return new EmailActionServerError(
    400,
    "AUTH_LINK_INVALID",
    type === "email"
      ? "This email-confirmation link is invalid or expired. Start again from Maintain Flow."
      : "This password link is invalid or expired. Request a new link.",
  )
}
