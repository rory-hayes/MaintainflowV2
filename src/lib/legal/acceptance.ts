export const MAINTAINFLOW_TERMS_VERSION = "2026-07-19" as const
export const MAINTAINFLOW_PRIVACY_VERSION = "2026-07-19" as const
export const MAINTAINFLOW_TERMS_LAST_UPDATED = "July 19, 2026" as const
export const MAINTAINFLOW_PRIVACY_LAST_UPDATED = "July 19, 2026" as const

export type LegalAcceptanceSource = "email_signup" | "oauth_callback" | "password_reset"

export type CurrentLegalAcceptance = {
  accepted: true
  termsVersion: typeof MAINTAINFLOW_TERMS_VERSION
  privacyVersion: typeof MAINTAINFLOW_PRIVACY_VERSION
  source: LegalAcceptanceSource
}

export function currentLegalAcceptance(source: LegalAcceptanceSource): CurrentLegalAcceptance {
  return {
    accepted: true,
    termsVersion: MAINTAINFLOW_TERMS_VERSION,
    privacyVersion: MAINTAINFLOW_PRIVACY_VERSION,
    source,
  }
}

export function isCurrentLegalAcceptance(
  value: unknown,
  expectedSource?: LegalAcceptanceSource
): value is CurrentLegalAcceptance {
  if (!value || typeof value !== "object") return false

  const candidate = value as Partial<CurrentLegalAcceptance>
  return candidate.accepted === true
    && candidate.termsVersion === MAINTAINFLOW_TERMS_VERSION
    && candidate.privacyVersion === MAINTAINFLOW_PRIVACY_VERSION
    && (
      candidate.source === "email_signup"
      || candidate.source === "oauth_callback"
      || candidate.source === "password_reset"
    )
    && (!expectedSource || candidate.source === expectedSource)
}

export function requireCurrentLegalAcceptance(
  value: unknown,
  expectedSource: LegalAcceptanceSource
): CurrentLegalAcceptance {
  if (!isCurrentLegalAcceptance(value, expectedSource)) {
    throw new Error("Accept the current Terms and acknowledge the Privacy Policy before continuing.")
  }

  return value
}
