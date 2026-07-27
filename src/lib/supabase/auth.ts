"use client"

import type { AuthUser } from "@/lib/auth-storage"
import { SignupConfirmationRequiredError, toActionableAuthError } from "../auth/errors.ts"
import { safeAuthNextPath } from "../auth/next-path.ts"
import {
  AUTH_PASSWORD_MIN_LENGTH,
  firstSignupValidationMessage,
  validateSignupInput,
} from "../auth/signup-validation.ts"
import {
  currentLegalAcceptance,
  MAINTAINFLOW_PRIVACY_VERSION,
  MAINTAINFLOW_TERMS_VERSION,
  requireCurrentLegalAcceptance,
  type CurrentLegalAcceptance,
} from "../legal/acceptance.ts"
import {
  clearPendingOAuthLegalAcceptance,
  preparePendingOAuthLegalAcceptance,
  readPendingOAuthLegalAcceptance,
} from "../legal/oauth-acceptance.ts"
import { getSupabaseConfig, SUPABASE_SESSION_KEY } from "./config.ts"
import { requireSupabaseAccountActivation } from "./user-auth.ts"

const SUPABASE_CODE_VERIFIER_KEY = `${SUPABASE_SESSION_KEY}-code-verifier`

type SupabaseAuthUser = {
  id: string
  email?: string
  user_metadata?: Record<string, unknown>
  created_at?: string
}

export type SupabaseSession = {
  access_token: string
  refresh_token: string
  expires_at: number
  user: SupabaseAuthUser
}

type AuthResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  user?: SupabaseAuthUser
  msg?: string
  error?: string
  error_description?: string
}

type OAuthUrlInput = {
  nextPath?: string
}

type StartOAuthInput = OAuthUrlInput & {
  legalAcceptance: CurrentLegalAcceptance
}

type PasswordResetInput = {
  password: string
  confirmPassword: string
  legalAcceptance: CurrentLegalAcceptance
}

type AuthLocation = Pick<Location, "hash" | "search">
export type EmailConfirmationLocationSnapshot = Readonly<AuthLocation>
export type PasswordResetLocationSnapshot = Readonly<AuthLocation>
type PkcePurpose = "oauth"

type AuthHistory = Pick<History, "replaceState">

export function captureAndScrubEmailConfirmationLocation(
  location: AuthLocation,
  history: AuthHistory
): EmailConfirmationLocationSnapshot {
  const snapshot = Object.freeze({
    hash: location.hash,
    search: location.search,
  })

  history.replaceState(null, "", "/auth/confirm")
  return snapshot
}

export function captureAndScrubPasswordResetLocation(
  location: AuthLocation,
  history: AuthHistory
): PasswordResetLocationSnapshot {
  const snapshot = Object.freeze({
    hash: location.hash,
    search: location.search,
  })

  history.replaceState(null, "", "/reset-password")
  return snapshot
}

function canUseStorage() {
  return typeof window !== "undefined" && "localStorage" in window
}

function authHeaders() {
  const config = getSupabaseConfig()
  if (!config.enabled) {
    throw new Error("Supabase authentication is not configured for an approved project.")
  }
  return {
    apikey: config.anonKey,
    "Content-Type": "application/json",
  }
}

function authUserToAppUser(user: SupabaseAuthUser): AuthUser {
  const metadata = user.user_metadata ?? {}
  const email = user.email ?? ""
  const name = typeof metadata.name === "string" ? metadata.name : email.split("@")[0] || "Maintain Flow User"
  const company = typeof metadata.company === "string" ? metadata.company : ""
  const role = typeof metadata.role === "string" ? metadata.role : "Agency Operator"
  const createdAt = user.created_at ?? new Date().toISOString()

  return {
    id: user.id,
    name,
    email,
    company,
    role,
    createdAt,
    lastLoginAt: new Date().toISOString(),
  }
}

function parseAuthError(payload: AuthResponse, fallback: string) {
  return toActionableAuthError(payload.error_description || payload.msg || payload.error || fallback, fallback)
}

async function parseAuthResponse(response: Response, fallback: string): Promise<AuthResponse> {
  const payload = (await response.json().catch(() => ({}))) as AuthResponse
  if (!response.ok) {
    throw new Error(parseAuthError(payload, fallback))
  }
  return payload
}

export function readSupabaseSession(): SupabaseSession | null {
  if (!canUseStorage()) return null

  try {
    const raw = window.localStorage.getItem(SUPABASE_SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SupabaseSession
  } catch {
    return null
  }
}

export function writeSupabaseSession(session: SupabaseSession) {
  if (canUseStorage()) {
    window.localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(session))
  }
}

export function clearSupabaseSession() {
  if (canUseStorage()) {
    window.localStorage.removeItem(SUPABASE_SESSION_KEY)
  }
}

export function getSupabaseAccessToken() {
  return readSupabaseSession()?.access_token ?? null
}

export async function getValidSupabaseAccessToken() {
  const session = readSupabaseSession()
  if (!session?.access_token) return null
  if (session.expires_at > Date.now() + 60_000) return session.access_token

  const user = await verifySupabaseSession()
  return user ? readSupabaseSession()?.access_token ?? null : null
}

export function getSupabaseCurrentUser() {
  const session = readSupabaseSession()
  return session?.user ? authUserToAppUser(session.user) : null
}

export async function verifySupabaseSession() {
  const session = readSupabaseSession()
  if (!session?.access_token) {
    return null
  }

  try {
    const currentSession = session.expires_at <= Date.now() + 60_000
      ? await refreshSupabaseSession(session)
      : session
    let user: SupabaseAuthUser

    try {
      user = await fetchSupabaseUser(currentSession.access_token)
    } catch {
      const refreshedSession = currentSession === session
        ? await refreshSupabaseSession(session)
        : currentSession
      user = refreshedSession.user?.id
        ? refreshedSession.user
        : await fetchSupabaseUser(refreshedSession.access_token)
      await requireSupabaseAccountActivation(refreshedSession.access_token, getSupabaseConfig())
      writeSupabaseSession({ ...refreshedSession, user })
      return authUserToAppUser(user)
    }

    await requireSupabaseAccountActivation(currentSession.access_token, getSupabaseConfig())
    writeSupabaseSession({ ...currentSession, user })
    return authUserToAppUser(user)
  } catch {
    clearSupabaseSession()
    return null
  }
}

export async function getSupabaseGoogleOAuthUrl(input: OAuthUrlInput = {}) {
  const config = getSupabaseConfig()
  if (!config.enabled) {
    throw new Error("Supabase authentication is not configured for an approved project.")
  }
  const siteUrl = getSiteUrl()
  const redirectTo = new URL("/auth/callback", siteUrl)

  const nextPath = safeAuthNextPath(input.nextPath, "")
  if (nextPath) redirectTo.searchParams.set("next", nextPath)

  const authorizeUrl = new URL(`${config.authUrl}/auth/v1/authorize`)
  authorizeUrl.searchParams.set("provider", "google")
  authorizeUrl.searchParams.set("redirect_to", redirectTo.toString())
  const pkce = await createAndStorePkceChallenge("oauth")
  authorizeUrl.searchParams.set("code_challenge", pkce.codeChallenge)
  authorizeUrl.searchParams.set("code_challenge_method", pkce.codeChallengeMethod)

  return authorizeUrl.toString()
}

export async function startSupabaseGoogleOAuth(input: StartOAuthInput) {
  if (typeof window === "undefined") {
    throw new Error("Google sign-in requires a browser environment.")
  }

  const nextPath = safeAuthNextPath(input.nextPath, "")
  preparePendingOAuthLegalAcceptance(input.legalAcceptance, nextPath)
  try {
    window.location.assign(await getSupabaseGoogleOAuthUrl({ nextPath }))
  } catch (error) {
    clearPendingOAuthLegalAcceptance()
    throw error
  }
}

export async function completeSupabaseOAuthFromLocation(location: AuthLocation) {
  const queryParams = new URLSearchParams(location.search)
  const error = authErrorFromParams(new URLSearchParams(), queryParams)

  if (error) {
    throw new Error(error)
  }

  if (authParamsFromLocation(location).get("access_token") || authParamsFromLocation(location).get("refresh_token")) {
    throw new Error("This link cannot sign you in automatically. Start again from Maintain Flow.")
  }

  const code = queryParams.get("code")
  if (!code) {
    throw new Error("Supabase did not return a protected sign-in code.")
  }

  const session = await exchangeSupabaseAuthCode(code, "Could not complete Google sign-in.", "oauth")
  await finalizeLegalAcceptanceForAuthCallback(session.access_token, location)
  await requireSupabaseAccountActivation(session.access_token, getSupabaseConfig())
  writeSupabaseSession(session)
  return authUserToAppUser(session.user)
}

export function hasSupabaseAuthRedirect(location: AuthLocation) {
  const queryParams = new URLSearchParams(location.search)

  return Boolean(
    queryParams.get("code") ||
    queryParams.get("error") ||
    queryParams.get("error_description")
  )
}

export async function completeSupabaseEmailConfirmationFromLocation(location: AuthLocation) {
  const params = authParamsFromLocation(location)
  const queryParams = new URLSearchParams(location.search)
  const error = authErrorFromParams(params, queryParams)
  if (error) throw new Error(error)

  if (params.get("access_token") || params.get("refresh_token") || queryParams.get("code")) {
    throw new Error("This confirmation link cannot install a session. Start again from Maintain Flow.")
  }

  const tokenHash = params.get("token_hash")
  if (params.get("type") !== "email" || !tokenHash) {
    throw new Error("This email-confirmation link is invalid or expired. Start again from Maintain Flow.")
  }

  await postSupabaseEmailAction({ type: "email", tokenHash })
  return { confirmed: true as const }
}

export async function completeSupabasePasswordResetFromLocation(location: AuthLocation, input: PasswordResetInput) {
  const legalAcceptance = requireCurrentLegalAcceptance(input.legalAcceptance, "password_reset")
  const password = input.password
  const confirmPassword = input.confirmPassword

  if (password.length < AUTH_PASSWORD_MIN_LENGTH) {
    throw new Error(`Use ${AUTH_PASSWORD_MIN_LENGTH} or more characters.`)
  }

  if (password !== confirmPassword) {
    throw new Error("Passwords do not match.")
  }

  const params = authParamsFromLocation(location)
  const queryParams = new URLSearchParams(location.search)
  const error = authErrorFromParams(params, queryParams)
  if (error) {
    throw new Error(error)
  }

  const recoveryType = params.get("type")
  const recoveryAccessToken = params.get("access_token")
  const recoveryRefreshToken = params.get("refresh_token")
  const recoveryTokenHash = params.get("token_hash")
  const hasFragmentCredential = Boolean(recoveryAccessToken || recoveryRefreshToken)
  const isTypedInvite = Boolean(
    recoveryType === "invite"
    && recoveryAccessToken
    && recoveryRefreshToken
  )
  if (hasFragmentCredential && !isTypedInvite) {
    throw new Error("This password link is invalid or expired. Request a new link.")
  }

  if (!isTypedInvite) {
    if (queryParams.get("code") || recoveryType !== "recovery" || !recoveryTokenHash) {
      throw new Error("Open the reset link from your Supabase email to update the password.")
    }

    await postSupabaseEmailAction({
      type: "recovery",
      tokenHash: recoveryTokenHash,
      password,
      legalAcceptance,
    })
    clearSupabaseSession()
    return { passwordUpdated: true as const }
  }

  const accessToken = recoveryAccessToken

  if (!accessToken) {
    throw new Error("Open the reset link from your Supabase email to update the password.")
  }

  try {
    await recordCurrentLegalAcceptance(
      accessToken,
      legalAcceptance,
      `legal-password-reset:${secureRandomUuid()}`
    )
  } catch (error) {
    clearSupabaseSession()
    throw error
  }

  const config = getSupabaseConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/user`, {
    method: "PUT",
    headers: {
      ...authHeaders(),
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ password }),
  })
  const payload = await parseAuthResponse(response, "Could not update the Supabase password.")
  const user = payload.user ?? ("id" in payload ? (payload as SupabaseAuthUser) : undefined)

  if (!user?.id) {
    throw new Error("Supabase did not return the updated user.")
  }

  try {
    await revokeSupabaseSession(accessToken)
  } catch {
    clearSupabaseSession()
    throw new Error("The password changed, but session cleanup could not be verified. Request a new reset link before signing in.")
  }
  clearSupabaseSession()

  return authUserToAppUser(user)
}

export async function signUpWithSupabase(input: {
  name: string
  email: string
  password: string
  company: string
  role: string
  nextPath?: string
  legalAcceptance: CurrentLegalAcceptance
}): Promise<AuthUser> {
  const config = getSupabaseConfig()
  const legalAcceptance = requireCurrentLegalAcceptance(input.legalAcceptance, "email_signup")
  const validation = validateSignupInput(input)
  if (!validation.ok) {
    throw new Error(firstSignupValidationMessage(validation.errors))
  }
  const signupRedirect = new URL("/auth/confirm", getSiteUrl())
  signupRedirect.searchParams.set("flow", "signup")
  const nextPath = safeAuthNextPath(input.nextPath, "")
  if (nextPath) signupRedirect.searchParams.set("next", nextPath)

  const response = await fetch(`${config.authUrl}/auth/v1/signup?redirect_to=${encodeURIComponent(signupRedirect.toString())}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email: validation.value.email,
      password: validation.value.password,
      data: {
        name: validation.value.name,
        company: validation.value.company,
        role: validation.value.role,
        maintainflow_legal_acceptance: {
          accepted: legalAcceptance.accepted,
          terms_version: legalAcceptance.termsVersion,
          privacy_version: legalAcceptance.privacyVersion,
          source: legalAcceptance.source,
        },
      },
    }),
  })
  const payload = await parseAuthResponse(response, "Could not create the Supabase account.")

  if (payload.access_token || payload.refresh_token) {
    clearSupabaseSession()
    if (!payload.access_token) {
      throw new Error("Supabase returned an incomplete signup session. Contact support before signing in.")
    }
    try {
      await revokeSupabaseSession(payload.access_token)
    } catch {
      throw new Error("The account was created, but its temporary signup session could not be revoked. Contact support before signing in.")
    }
  }

  throw new SignupConfirmationRequiredError()
}

async function finalizeLegalAcceptanceForAuthCallback(accessToken: string, location: AuthLocation) {
  const queryParams = new URLSearchParams(location.search)
  const expectedNextPath = safeAuthNextPath(queryParams.get("next"), "")
  const pendingState = readPendingOAuthLegalAcceptance(expectedNextPath)

  if (pendingState.status === "invalid") {
    clearPendingOAuthLegalAcceptance()
    throw new Error("The Terms and Privacy acceptance expired or did not match this sign-in. Start again.")
  }

  if (pendingState.status === "ready") {
    await recordCurrentLegalAcceptance(
      accessToken,
      currentLegalAcceptance("oauth_callback"),
      pendingState.pending.idempotencyKey
    )
    clearPendingOAuthLegalAcceptance()
    return
  }

  // A returning OAuth user may already have the exact current acceptance.
  // Verify that durable row instead of treating a missing pending state as consent.
  const response = await fetch("/api/legal/acceptance", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  })
  await requireRecordedLegalAcceptance(response)
}

async function recordCurrentLegalAcceptance(
  accessToken: string,
  acceptance: CurrentLegalAcceptance,
  idempotencyKey: string
) {
  const response = await fetch("/api/legal/acceptance", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(acceptance),
    cache: "no-store",
  })
  await requireRecordedLegalAcceptance(response)
}

async function requireRecordedLegalAcceptance(response: Response) {
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    data?: { accepted?: boolean; termsVersion?: string; privacyVersion?: string; acceptedAt?: string | null }
    error?: { message?: string }
  } | null

  if (
    !response.ok
    || payload?.ok !== true
    || payload.data?.accepted !== true
    || payload.data.termsVersion !== MAINTAINFLOW_TERMS_VERSION
    || payload.data.privacyVersion !== MAINTAINFLOW_PRIVACY_VERSION
    || typeof payload.data.acceptedAt !== "string"
    || !payload.data.acceptedAt
  ) {
    throw new Error(
      payload?.error?.message
      || "Your account was not opened because the current Terms and Privacy acceptance could not be verified. Start again."
    )
  }
}

function secureRandomUuid() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure browser randomness is unavailable. Update your browser and try again.")
  }

  return globalThis.crypto.randomUUID()
}

export async function signInWithSupabase(input: { email: string; password: string }) {
  const config = getSupabaseConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email: input.email.trim().toLowerCase(),
      password: input.password,
    }),
  })
  const payload = await parseAuthResponse(response, "Email or password did not match a Supabase account.")

  if (!payload.access_token || !payload.refresh_token || !payload.user) {
    throw new Error("Supabase did not return a complete session.")
  }

  try {
    await requireSupabaseAccountActivation(payload.access_token, getSupabaseConfig())
  } catch (error) {
    clearSupabaseSession()
    await revokeSupabaseSession(payload.access_token).catch(() => undefined)
    throw error
  }

  const session: SupabaseSession = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    user: payload.user,
  }
  writeSupabaseSession(session)

  return authUserToAppUser(payload.user)
}

export async function signOutSupabase() {
  const config = getSupabaseConfig()
  const token = getSupabaseAccessToken()

  if (token) {
    await fetch(`${config.authUrl}/auth/v1/logout`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        Authorization: `Bearer ${token}`,
      },
    }).catch(() => undefined)
  }

  clearSupabaseSession()
}

async function fetchSupabaseUser(accessToken: string) {
  const config = getSupabaseConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/user`, {
    headers: {
      ...authHeaders(),
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const payload = (await response.json().catch(() => ({}))) as SupabaseAuthUser & AuthResponse

  if (!response.ok) {
    throw new Error(parseAuthError(payload, "Could not load the Supabase OAuth user."))
  }

  if (!payload.id) {
    throw new Error("Supabase did not return an OAuth user.")
  }

  return payload
}

async function revokeSupabaseSession(accessToken: string) {
  const config = getSupabaseConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      Authorization: `Bearer ${accessToken}`,
    },
  })
  if (!response.ok) {
    throw new Error("Supabase could not revoke the temporary authentication session.")
  }
}

function getSiteUrl() {
  if (typeof window !== "undefined") {
    return window.location.origin
  }

  return process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
}

export async function requestSupabasePasswordReset(email: string) {
  const config = getSupabaseConfig()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || window.location.origin
  const resetRedirect = new URL("/reset-password", siteUrl)
  resetRedirect.searchParams.set("flow", "recovery")
  const response = await fetch(`${config.authUrl}/auth/v1/recover`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      redirect_to: resetRedirect.toString(),
    }),
  })
  await parseAuthResponse(response, "Could not send a Supabase password reset email.")
}

type EmailActionInput =
  | { type: "email"; tokenHash: string }
  | {
      type: "recovery"
      tokenHash: string
      password: string
      legalAcceptance: CurrentLegalAcceptance
    }

async function postSupabaseEmailAction(input: EmailActionInput) {
  const response = await fetch("/api/auth/email-action", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
    credentials: "same-origin",
  })
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean
    error?: { message?: string }
  } | null

  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      payload?.error?.message
      || (input.type === "email"
        ? "This email-confirmation link is invalid or expired. Start again from Maintain Flow."
        : "This password link is invalid or expired. Request a new link.")
    )
  }
}

function authParamsFromLocation(location: Pick<Location, "hash">) {
  return new URLSearchParams(location.hash.replace(/^#/, ""))
}

function authErrorFromParams(params: URLSearchParams, queryParams: URLSearchParams) {
  return params.get("error_description") || params.get("error") || queryParams.get("error_description") || queryParams.get("error")
}

async function exchangeSupabaseAuthCode(code: string, fallback: string, purpose: PkcePurpose): Promise<SupabaseSession> {
  const codeVerifier = consumePkceCodeVerifier(purpose)
  if (!codeVerifier) {
    throw new Error("The sign-in link expired in this browser. Start again from Maintain Flow.")
  }

  const config = getSupabaseConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      auth_code: code,
      code_verifier: codeVerifier,
    }),
  })
  const payload = await parseAuthResponse(response, fallback)

  if (!payload.access_token || !payload.refresh_token || !payload.user) {
    throw new Error("Supabase did not return a complete session.")
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    user: payload.user,
  }
}

async function refreshSupabaseSession(session: SupabaseSession): Promise<SupabaseSession> {
  if (!session.refresh_token) {
    throw new Error("The Supabase session cannot be refreshed.")
  }

  const config = getSupabaseConfig()
  const response = await fetch(`${config.authUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  })
  const payload = await parseAuthResponse(response, "Your session expired. Log in again to continue.")

  if (!payload.access_token || !payload.refresh_token) {
    throw new Error("Supabase did not return a complete refreshed session.")
  }

  const refreshedSession: SupabaseSession = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    user: payload.user ?? session.user,
  }
  return refreshedSession
}

async function createAndStorePkceChallenge(purpose: PkcePurpose) {
  const verifier = generatePkceVerifier()
  writePkceCodeVerifier(verifier, purpose)
  const codeChallenge = await generatePkceChallenge(verifier)

  return {
    codeChallenge,
    codeChallengeMethod: "s256",
  }
}

function writePkceCodeVerifier(verifier: string, purpose: PkcePurpose) {
  if (!canUseStorage()) {
    throw new Error("Google sign-in requires browser storage. Enable local storage and try again.")
  }

  window.localStorage.setItem(pkceVerifierKey(purpose), verifier)
}

function consumePkceCodeVerifier(purpose: PkcePurpose) {
  if (!canUseStorage()) return null
  const key = pkceVerifierKey(purpose)
  const verifier = window.localStorage.getItem(key)
  window.localStorage.removeItem(key)
  return verifier
}

function pkceVerifierKey(purpose: PkcePurpose) {
  return `${SUPABASE_CODE_VERIFIER_KEY}:${purpose}`
}

function generatePkceVerifier() {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Protected sign-in requires secure browser randomness. Update your browser and try again.")
  }
  const values = new Uint8Array(32)
  cryptoApi.getRandomValues(values)
  return base64UrlEncode(values)
}

async function generatePkceChallenge(verifier: string) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === "undefined") {
    throw new Error("Protected sign-in requires SHA-256 browser support. Update your browser and try again.")
  }

  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ""
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  const encoded = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64")

  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
