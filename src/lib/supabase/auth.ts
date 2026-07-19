"use client"

import type { AuthUser } from "@/lib/auth-storage"
import { SignupConfirmationRequiredError, toActionableAuthError } from "../auth/errors.ts"
import { safeAuthNextPath } from "../auth/next-path.ts"
import {
  AUTH_PASSWORD_MIN_LENGTH,
  firstSignupValidationMessage,
  validateSignupInput,
} from "../auth/signup-validation.ts"
import { getSupabaseConfig, SUPABASE_SESSION_KEY } from "./config.ts"

const SUPABASE_CODE_VERIFIER_KEY = `${SUPABASE_SESSION_KEY}-code-verifier`
const PKCE_VERIFIER_LENGTH = 56
const PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

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

type PasswordResetInput = {
  password: string
  confirmPassword: string
}

type AuthLocation = Pick<Location, "hash" | "search">

function canUseStorage() {
  return typeof window !== "undefined" && "localStorage" in window
}

function authHeaders() {
  const config = getSupabaseConfig()
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
      writeSupabaseSession({ ...refreshedSession, user })
      return authUserToAppUser(user)
    }

    writeSupabaseSession({ ...currentSession, user })
    return authUserToAppUser(user)
  } catch {
    clearSupabaseSession()
    return null
  }
}

export async function getSupabaseGoogleOAuthUrl(input: OAuthUrlInput = {}) {
  const config = getSupabaseConfig()
  const siteUrl = getSiteUrl()
  const redirectTo = new URL("/auth/callback", siteUrl)

  const nextPath = safeAuthNextPath(input.nextPath, "")
  if (nextPath) redirectTo.searchParams.set("next", nextPath)

  const authorizeUrl = new URL(`${config.authUrl}/auth/v1/authorize`)
  authorizeUrl.searchParams.set("provider", "google")
  authorizeUrl.searchParams.set("redirect_to", redirectTo.toString())
  const pkce = await createAndStorePkceChallenge()
  authorizeUrl.searchParams.set("code_challenge", pkce.codeChallenge)
  authorizeUrl.searchParams.set("code_challenge_method", pkce.codeChallengeMethod)

  return authorizeUrl.toString()
}

export async function startSupabaseGoogleOAuth(input: OAuthUrlInput = {}) {
  if (typeof window === "undefined") {
    throw new Error("Google sign-in requires a browser environment.")
  }

  window.location.assign(await getSupabaseGoogleOAuthUrl(input))
}

export async function completeSupabaseOAuthFromLocation(location: AuthLocation) {
  const params = authParamsFromLocation(location)
  const queryParams = new URLSearchParams(location.search)
  const accessToken = params.get("access_token")
  const refreshToken = params.get("refresh_token")
  const expiresIn = Number(params.get("expires_in") ?? 3600)
  const error = authErrorFromParams(params, queryParams)

  if (error) {
    throw new Error(error)
  }

  if (!accessToken || !refreshToken) {
    const code = queryParams.get("code")
    if (code) {
      const session = await exchangeSupabaseAuthCode(code, "Could not complete Google sign-in.")
      writeSupabaseSession(session)
      return authUserToAppUser(session.user)
    }
    throw new Error("Supabase did not return an OAuth session.")
  }

  const user = await fetchSupabaseUser(accessToken)
  const session: SupabaseSession = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
    user,
  }
  writeSupabaseSession(session)

  return authUserToAppUser(user)
}

export function hasSupabaseAuthRedirect(location: AuthLocation) {
  const params = authParamsFromLocation(location)
  const queryParams = new URLSearchParams(location.search)

  return Boolean(
    params.get("access_token") ||
    params.get("refresh_token") ||
    params.get("error") ||
    params.get("error_description") ||
    queryParams.get("code") ||
    queryParams.get("error") ||
    queryParams.get("error_description")
  )
}

export async function completeSupabasePasswordResetFromLocation(location: AuthLocation, input: PasswordResetInput) {
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

  const recoveryAccessToken = params.get("access_token")
  const recoveryRefreshToken = params.get("refresh_token")
  const expiresIn = Number(params.get("expires_in") ?? 3600)
  const existingSession = readSupabaseSession()
  const recoveryCode = queryParams.get("code")
  const exchangedSession = !recoveryAccessToken && recoveryCode
    ? await exchangeSupabaseAuthCode(recoveryCode, "Could not verify the password reset link.")
    : null
  const accessToken = recoveryAccessToken || exchangedSession?.access_token || existingSession?.access_token

  if (!accessToken) {
    throw new Error("Open the reset link from your Supabase email to update the password.")
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
  const user = payload.user ?? ("id" in payload ? (payload as SupabaseAuthUser) : existingSession?.user)

  if (!user?.id) {
    throw new Error("Supabase did not return the updated user.")
  }

  if (exchangedSession) {
    writeSupabaseSession({ ...exchangedSession, user })
  } else if (recoveryAccessToken && recoveryRefreshToken) {
    writeSupabaseSession({
      access_token: recoveryAccessToken,
      refresh_token: recoveryRefreshToken,
      expires_at: Date.now() + expiresIn * 1000,
      user,
    })
  } else if (existingSession) {
    writeSupabaseSession({ ...existingSession, user })
  }

  return authUserToAppUser(user)
}

export async function signUpWithSupabase(input: {
  name: string
  email: string
  password: string
  company: string
  role: string
  nextPath?: string
}) {
  const config = getSupabaseConfig()
  const validation = validateSignupInput(input)
  if (!validation.ok) {
    throw new Error(firstSignupValidationMessage(validation.errors))
  }
  const signupRedirect = new URL("/auth/callback", getSiteUrl())
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
      },
    }),
  })
  const payload = await parseAuthResponse(response, "Could not create the Supabase account.")

  if (!payload.user) {
    throw new SignupConfirmationRequiredError()
  }

  if (payload.access_token && payload.refresh_token) {
    const session: SupabaseSession = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
      user: payload.user,
    }
    writeSupabaseSession(session)
    return authUserToAppUser(payload.user)
  }

  throw new SignupConfirmationRequiredError()
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

function getSiteUrl() {
  if (typeof window !== "undefined") {
    return window.location.origin
  }

  return process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
}

export async function requestSupabasePasswordReset(email: string) {
  const config = getSupabaseConfig()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || window.location.origin
  const pkce = await createAndStorePkceChallenge()
  const response = await fetch(`${config.authUrl}/auth/v1/recover`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      redirect_to: `${siteUrl.replace(/\/+$/, "")}/reset-password`,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: pkce.codeChallengeMethod,
    }),
  })
  await parseAuthResponse(response, "Could not send a Supabase password reset email.")
}

function authParamsFromLocation(location: Pick<Location, "hash">) {
  return new URLSearchParams(location.hash.replace(/^#/, ""))
}

function authErrorFromParams(params: URLSearchParams, queryParams: URLSearchParams) {
  return params.get("error_description") || params.get("error") || queryParams.get("error_description") || queryParams.get("error")
}

async function exchangeSupabaseAuthCode(code: string, fallback: string): Promise<SupabaseSession> {
  const codeVerifier = consumePkceCodeVerifier()
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
  writeSupabaseSession(refreshedSession)
  return refreshedSession
}

async function createAndStorePkceChallenge() {
  const verifier = generatePkceVerifier()
  writePkceCodeVerifier(verifier)
  const codeChallenge = await generatePkceChallenge(verifier)

  return {
    codeChallenge,
    codeChallengeMethod: codeChallenge === verifier ? "plain" : "s256",
  }
}

function writePkceCodeVerifier(verifier: string) {
  if (!canUseStorage()) {
    throw new Error("Google sign-in requires browser storage. Enable local storage and try again.")
  }

  window.localStorage.setItem(SUPABASE_CODE_VERIFIER_KEY, verifier)
}

function consumePkceCodeVerifier() {
  if (!canUseStorage()) return null
  const verifier = window.localStorage.getItem(SUPABASE_CODE_VERIFIER_KEY)
  window.localStorage.removeItem(SUPABASE_CODE_VERIFIER_KEY)
  return verifier
}

function generatePkceVerifier() {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.getRandomValues) {
    const values = new Uint8Array(PKCE_VERIFIER_LENGTH)
    cryptoApi.getRandomValues(values)
    return Array.from(values, (value) => PKCE_CHARSET[value % PKCE_CHARSET.length]).join("")
  }

  let verifier = ""
  for (let index = 0; index < PKCE_VERIFIER_LENGTH; index += 1) {
    verifier += PKCE_CHARSET[Math.floor(Math.random() * PKCE_CHARSET.length)]
  }
  return verifier
}

async function generatePkceChallenge(verifier: string) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === "undefined") {
    return verifier
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
