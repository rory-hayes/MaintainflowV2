import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const termsSource = readFileSync("src/app/terms/page.tsx", "utf8")
const privacySource = readFileSync("src/app/privacy/page.tsx", "utf8")
const securitySource = readFileSync("src/app/security/page.tsx", "utf8")

test("public terms preserve immediate self-serve access to one workspace", () => {
  assert.match(termsSource, /self-serve Business Evals service/)
  assert.match(termsSource, /sign up and create one workspace/)
  assert.match(termsSource, /without an application, call, manual invitation, or founder approval/)
  assert.match(termsSource, /access and normal activation do not depend on a meeting/)

  assert.doesNotMatch(termsSource, /€1,500|founder-led validation engagement|written pilot order|paid upfront/)
})

test("public terms lock Business Evals pricing, the card-free trial, grandfathering, and cancellation", () => {
  assert.match(termsSource, /Free is €0 and includes 1 project, 1 journey, 35 runs per month, 7-day evidence retention, and 1 seat/)
  assert.match(termsSource, /Solo is €49 monthly for 3 projects, 5 journeys, 750 runs, 30-day evidence, and 2 seats/)
  assert.match(termsSource, /Team is €149 monthly for 15 projects, 30 journeys, 7,500 runs, 90-day evidence, and 5 seats/)
  assert.match(termsSource, /Agency is €399 monthly for 50 projects, 100 journeys, 30,000 runs, 365-day evidence, and 15 seats/)
  assert.match(termsSource, /Annual billing is discounted by 10%/)
  assert.match(termsSource, /one card-free 14-day Team trial/)
  assert.match(termsSource, /returns to Free at expiry/)
  assert.match(termsSource, /will not silently move a legacy subscription to a new price or contract/)
  assert.match(termsSource, /Stripe Customer Portal from Settings/)
  assert.match(termsSource, /cancel without a call/)
  assert.match(termsSource, /paid capacity ends and Free limits apply/)
  assert.match(termsSource, /Stripe reports an eligible trialing or active subscription/)
  assert.match(securitySource, /signature-verified webhooks determine paid state/)
  assert.doesNotMatch(termsSource, /14-day Stripe-managed trial/)
})

test("public terms require target permission and keep execution inside the safe operating boundary", () => {
  assert.match(termsSource, /explicit permission to test/)
  assert.match(termsSource, /attest target authority and that the journey, frequency, synthetic data, and expected effects are safe and non-destructive/)
  assert.match(termsSource, /legacy credential-free public HTTPS GET endpoint journeys/)
  assert.match(termsSource, /stop when it encounters CAPTCHA, MFA, access controls, anti-bot challenges, payment controls/)
  assert.match(termsSource, /does not bypass CAPTCHA, MFA, access controls, anti-bot systems, or rate limits/)
  assert.match(termsSource, /autonomously deploy or repair a customer system/)
  assert.match(securitySource, /does not bypass controls, make real purchases, or autonomously modify production/)
})

test("public terms define deterministic verdicts, bound AI assistance, and require evidence review", () => {
  assert.match(termsSource, /Required deterministic assertions produce pass or fail/)
  assert.match(termsSource, /uncertainty produces inconclusive/)
  assert.match(termsSource, /not a guarantee that every defect, outage, security issue, data error, or business loss will be found or prevented/)
  assert.match(termsSource, /AI does not set or override verdicts, invent evidence, attest authorization, or certify compliance/)
  assert.match(termsSource, /not a penetration test, security audit, compliance certification, backup service/)
  assert.match(termsSource, /review live links, emails, webhook payloads, and PDFs for accuracy, confidentiality, audience, permissions, and necessary redactions before sharing/)
  assert.match(securitySource, /Only service-issued runs over an immutable journey version can produce a verdict/)
})

test("privacy and security pages match the Business Evals data and trust boundaries", () => {
  assert.match(termsSource, /href="\/privacy"/)
  assert.match(privacySource, /Business Evals workspaces, journey runs, evidence, product usage, legacy endpoint journeys, and subscriptions/)
  assert.match(privacySource, /Maintain Flow does not store full card or bank-account numbers/)
  assert.match(privacySource, /without requiring applications, qualification calls, or cross-visit public tracking/)
  assert.match(privacySource, /minimum personal data necessary/)
  assert.match(privacySource, /No meeting is required to exercise a data right/)
  assert.match(securitySource, /production database access is constrained by row-level security rather than client-side filtering/)
  assert.match(securitySource, /Legacy endpoint journeys retain public-HTTPS GET, DNS, redirect, response-size, and SSRF controls/)
  assert.match(securitySource, /Every production release is gated on isolation, authorization, SSRF, CAPTCHA, email-correlation, verdict, evidence, retention, billing, rollback, provider-smoke, and exact-deployment checks/)
  assert.match(securitySource, /browser users cannot write entitlement fields/)
  assert.match(securitySource, /not a third-party security or compliance certification/)
})
