const exactLegalVersion = "2026-07-19"

export function validateLegalReleaseManifest(manifest, expectedCommit) {
  const results = []
  const professionalReview = manifest?.professionalReview
  results.push(result(manifest?.schemaVersion === 1, "Legal release manifest uses schema version 1"))
  results.push(result(
    manifest?.termsVersion === exactLegalVersion && manifest?.privacyVersion === exactLegalVersion,
    `Legal release manifest is bound to Terms and Privacy ${exactLegalVersion}`,
  ))
  results.push(result(
    typeof manifest?.releaseCommit === "string"
      && /^[a-f0-9]{40}$/.test(manifest.releaseCommit)
      && manifest.releaseCommit === expectedCommit,
    "Legal release manifest is bound to the exact release commit",
  ))
  results.push(result(
    manifest?.operatorFactsConfirmed === true,
    "Contracting entity, contact, tax, governing-law and customer-classification facts are confirmed",
  ))
  results.push(result(
    professionalReview?.completed === true
      && professionalReview?.scope === "terms_privacy_checkout"
      && typeof professionalReview?.reviewer === "string"
      && professionalReview.reviewer.trim().length >= 3
      && validPastIsoDate(professionalReview?.reviewedAt),
    "Qualified professional review covers the exact Terms, Privacy and checkout release",
  ))
  results.push(result(
    manifest?.approvedForPublicCheckout === true && manifest?.approvedForDomainCutover === true,
    "The reviewed manifest explicitly approves public checkout and canonical-domain cutover",
  ))
  return results
}

function validPastIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp <= Date.now()
}

function result(ok, message) {
  return { level: ok ? "OK" : "BLOCK", message }
}
