"use client"

import {
  MAINTAINFLOW_PRIVACY_VERSION,
  MAINTAINFLOW_TERMS_VERSION,
  requireCurrentLegalAcceptance,
  type CurrentLegalAcceptance,
} from "./acceptance.ts"

export const OAUTH_LEGAL_ACCEPTANCE_PENDING_KEY = "maintainflow-oauth-legal-acceptance-v1"
export const OAUTH_LEGAL_ACCEPTANCE_MAX_AGE_MS = 20 * 60 * 1000

export type PendingOAuthLegalAcceptance = {
  accepted: true
  termsVersion: typeof MAINTAINFLOW_TERMS_VERSION
  privacyVersion: typeof MAINTAINFLOW_PRIVACY_VERSION
  source: "oauth_callback"
  idempotencyKey: string
  nextPath: string
  initiatedAt: number
}

export type PendingOAuthLegalAcceptanceState =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ready"; pending: PendingOAuthLegalAcceptance }

export function preparePendingOAuthLegalAcceptance(
  acceptance: CurrentLegalAcceptance,
  nextPath: string,
  now = Date.now()
) {
  const verified = requireCurrentLegalAcceptance(acceptance, "oauth_callback")
  const storage = requireSessionStorage()
  const pending: PendingOAuthLegalAcceptance = {
    accepted: true,
    termsVersion: verified.termsVersion,
    privacyVersion: verified.privacyVersion,
    source: "oauth_callback",
    idempotencyKey: `legal-oauth:${secureRandomUuid()}`,
    nextPath,
    initiatedAt: now,
  }

  storage.setItem(OAUTH_LEGAL_ACCEPTANCE_PENDING_KEY, JSON.stringify(pending))
  return pending
}

export function readPendingOAuthLegalAcceptance(
  expectedNextPath: string,
  now = Date.now()
): PendingOAuthLegalAcceptanceState {
  let raw: string | null
  try {
    raw = requireSessionStorage().getItem(OAUTH_LEGAL_ACCEPTANCE_PENDING_KEY)
  } catch {
    return { status: "invalid" }
  }
  if (!raw) return { status: "absent" }

  try {
    const pending = JSON.parse(raw) as Partial<PendingOAuthLegalAcceptance>
    if (
      pending.accepted !== true
      || pending.termsVersion !== MAINTAINFLOW_TERMS_VERSION
      || pending.privacyVersion !== MAINTAINFLOW_PRIVACY_VERSION
      || pending.source !== "oauth_callback"
      || typeof pending.idempotencyKey !== "string"
      || !/^legal-oauth:[0-9a-f-]{36}$/i.test(pending.idempotencyKey)
      || typeof pending.initiatedAt !== "number"
      || !Number.isFinite(pending.initiatedAt)
      || pending.initiatedAt > now + 60_000
      || now - pending.initiatedAt > OAUTH_LEGAL_ACCEPTANCE_MAX_AGE_MS
      || pending.nextPath !== expectedNextPath
    ) {
      return { status: "invalid" }
    }

    return { status: "ready", pending: pending as PendingOAuthLegalAcceptance }
  } catch {
    return { status: "invalid" }
  }
}

export function clearPendingOAuthLegalAcceptance() {
  try {
    requireSessionStorage().removeItem(OAUTH_LEGAL_ACCEPTANCE_PENDING_KEY)
  } catch {
    // The auth callback remains fail-closed if browser storage is unavailable.
  }
}

function requireSessionStorage() {
  if (typeof window === "undefined" || !("sessionStorage" in window)) {
    throw new Error("Google sign-in requires tab-scoped browser storage. Enable storage and try again.")
  }

  return window.sessionStorage
}

function secureRandomUuid() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Google sign-in requires secure browser randomness. Update your browser and try again.")
  }

  return globalThis.crypto.randomUUID()
}
