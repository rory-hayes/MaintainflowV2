export function isCurrentSentryOrganizationToken(value) {
  const token = String(value || "").trim()
  if (!token.startsWith("sntrys_")) return false

  const [encodedClaims, signature, ...extra] = token.slice("sntrys_".length).split("_")
  return extra.length === 0
    && encodedClaims.length >= 20
    && encodedClaims.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(encodedClaims)
    && signature.length >= 32
    && /^[A-Za-z0-9+/-]+$/.test(signature)
}
