import assert from "node:assert/strict"
import test from "node:test"

import { validateLegalReleaseManifest } from "../scripts/lib/legal-release-manifest.mjs"

const releaseCommit = "a".repeat(40)

test("legal release manifest binds reviewed approval to the exact release", () => {
  const results = validateLegalReleaseManifest({
    schemaVersion: 1,
    termsVersion: "2026-07-19",
    privacyVersion: "2026-07-19",
    releaseCommit,
    operatorFactsConfirmed: true,
    professionalReview: {
      completed: true,
      scope: "terms_privacy_checkout",
      reviewer: "Qualified reviewer",
      reviewedAt: "2026-07-19T12:00:00.000Z",
    },
    approvedForPublicCheckout: true,
    approvedForDomainCutover: true,
  }, releaseCommit)

  assert.equal(results.every((result) => result.level === "OK"), true)
})

test("legal release manifest blocks placeholders, stale documents and a different commit", () => {
  const results = validateLegalReleaseManifest({
    schemaVersion: 1,
    termsVersion: "draft",
    privacyVersion: "draft",
    releaseCommit: "b".repeat(40),
    operatorFactsConfirmed: false,
    professionalReview: {
      completed: false,
      scope: "informal",
      reviewer: "",
      reviewedAt: "2099-01-01T00:00:00.000Z",
    },
    approvedForPublicCheckout: false,
    approvedForDomainCutover: false,
  }, releaseCommit)

  assert.equal(results.filter((result) => result.level === "BLOCK").length, 5)
  assert.equal(results.some((result) => result.message.includes("exact release commit")), true)
  assert.equal(results.some((result) => result.message.includes("public checkout")), true)
})
