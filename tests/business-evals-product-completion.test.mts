import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { extractAllowlistedVerificationLink } from "../src/lib/email/eval-inbound.ts"
import { validateActionManifest } from "../src/lib/evals/manifest.ts"

const semanticLocator = { kind: "label" as const, value: "Country" }

test("restricted manifests support safe select and checked controls without opening an automation escape hatch", () => {
  const manifest = validateActionManifest({
    actions: [
      {
        id: "select-country",
        label: "Choose the synthetic country",
        type: "fill",
        operation: "select",
        locator: semanticLocator,
        optionValue: "IE",
        timeoutMs: 10_000,
      },
      {
        id: "accept-terms",
        label: "Accept terms for the synthetic account",
        type: "fill",
        operation: "check",
        locator: { kind: "label", value: "Accept terms" },
        expectedChecked: true,
        operatorApproved: true,
        controlKind: "checkbox",
        timeoutMs: 10_000,
      },
    ],
  })

  assert.equal(manifest.actions[0]?.type, "fill")
  assert.equal(manifest.actions[0]?.operation, "select")
  assert.equal(manifest.actions[1]?.type, "fill")
  assert.equal(manifest.actions[1]?.operation, "check")
  assert.throws(() => validateActionManifest({
    actions: [{
      id: "unsafe-check",
      label: "Uncheck a real preference",
      type: "fill",
      operation: "check",
      locator: { kind: "label", value: "Marketing" },
      expectedChecked: false,
      operatorApproved: true,
      controlKind: "checkbox",
      timeoutMs: 10_000,
    }],
  }), /explicit checked state/)
  assert.throws(() => validateActionManifest({
    actions: [{
      id: "unsafe-select",
      label: "Run custom selection code",
      type: "fill",
      operation: "select",
      locator: semanticLocator,
      optionValue: "IE",
      script: "document.querySelector('select').value = 'IE'",
      timeoutMs: 10_000,
    }],
  }), /Arbitrary JavaScript/)
})

test("email verification opens only one link matching the immutable host, path, text and query rule", () => {
  const rules = [{
    host: "accounts.example.com",
    pathPrefix: "/verify",
    requiredText: "Verify email",
    requiredQueryParameter: "token",
  }]
  const unique = extractAllowlistedVerificationLink({
    html: '<a href="https://accounts.example.com/verify?token=one">Verify email</a>',
    rules,
  })
  assert.equal(unique, "https://accounts.example.com/verify?token=one")

  assert.equal(extractAllowlistedVerificationLink({
    html: '<a href="https://accounts.example.com/settings?token=one">Verify email</a>',
    rules,
  }), null)
  assert.equal(extractAllowlistedVerificationLink({
    html: '<a href="https://accounts.example.com/verify?token=one">View account</a>',
    rules,
  }), null)
  assert.equal(extractAllowlistedVerificationLink({
    html: '<a href="https://accounts.example.com/verify">Verify email</a>',
    rules,
  }), null)
  assert.equal(extractAllowlistedVerificationLink({
    html: [
      '<a href="https://accounts.example.com/verify?token=one">Verify email</a>',
      '<a href="https://accounts.example.com/verify?token=two">Verify email</a>',
    ].join(""),
    rules,
  }), null)
})

test("the Business Evals public positioning is the unconditional canonical homepage", () => {
  const home = readFileSync("src/app/page.tsx", "utf8")
  const layout = readFileSync("src/app/layout.tsx", "utf8")
  const landing = readFileSync("src/sections/business-evals-landing.tsx", "utf8")
  assert.match(home, /<BusinessEvalsLanding \/>/)
  assert.doesNotMatch(home, /isBusinessEvalsMarketingEnabled|<Hero \/>|<Features \/>|<Integrations \/>/)
  assert.doesNotMatch(layout, /isBusinessEvalsMarketingEnabled|businessEvalsMarketing/)
  assert.match(landing, /browser-only Lead form journey on Free/)
  assert.match(landing, /Trial signup/)
  assert.match(landing, /Bounded by design for public journeys/)
  assert.doesNotMatch(landing, /Safe enough for production journeys|production-ready|now live/i)
})

test("the builder exposes every deterministic launch configuration and owner-approved action domains", () => {
  const builder = readFileSync("src/components/evals/pages/journeys-pages.tsx", "utf8")
  const projects = readFileSync("src/components/evals/pages/projects-pages.tsx", "utf8")
  const scanner = readFileSync("src/lib/runner/page-scan.server.ts", "utf8")
  const controlMapping = readFileSync("src/lib/evals/form-control-mapping.ts", "utf8")

  for (const label of ["Thank-you text", "Exact success URL", "Accessible form state"]) assert.match(builder, new RegExp(label))
  for (const inputType of ["number", "url", "checkbox", "radio"]) assert.match(`${builder}\n${controlMapping}`, new RegExp(`\\"${inputType}\\"`))
  assert.match(controlMapping, /inputType\.toLowerCase\(\) === "tel"/)
  assert.match(builder, /operation: "select"/)
  assert.match(builder, /maximumWaitSeconds/)
  assert.match(builder, /Required path prefix/)
  assert.match(builder, /Required link text/)
  assert.match(builder, /Required query property/)
  assert.match(projects, /approvedActionDomains/)
  assert.match(projects, /Explicitly approved action domains/)
  assert.match(scanner, /options:/)
})

test("Business Evals routes avoid the legacy workspace mirror while legacy fallbacks retain it", () => {
  const boundary = readFileSync("src/components/app/legacy-core-loop-boundary.tsx", "utf8")
  const conditional = readFileSync("src/components/evals/evals-conditional-route.tsx", "utf8")
  const onboarding = readFileSync("src/components/evals/pages/onboarding-page.tsx", "utf8")
  const journeys = readFileSync("src/components/evals/pages/journeys-pages.tsx", "utf8")
  const journeyDetail = readFileSync("src/components/evals/pages/journey-detail-page.tsx", "utf8")
  const journeyServer = readFileSync("src/lib/api/journeys.server.ts", "utf8")

  assert.doesNotMatch(boundary, /"\/reports"/)
  assert.doesNotMatch(boundary, /"\/onboarding"/)
  const legacyPrefixList = boundary.match(/const legacyPrefixes = \[[\s\S]*?\n\]/)?.[0] ?? ""
  assert.doesNotMatch(legacyPrefixList, /"\/settings"/)
  assert.match(boundary, /pathname === "\/settings"/)
  assert.match(conditional, /legacyWithProvider = <CoreLoopProvider>/)
  assert.match(conditional, /BUSINESS_EVALS_PREVIEW === "1"/)
  assert.match(conditional, /<EvalsRouteBoundary previewEnabled>/)
  assert.match(onboarding, /Lead forms can run no more often than hourly/)
  assert.match(onboarding, /Trial signup journeys no more often than every six hours/)
  assert.match(journeys, /Browser only/)
  assert.match(journeys, /Browser \+ email \+ cleanup/)
  assert.match(journeys, /journey\.template === "trial_signup"\) return "Browser \+ email \+ cleanup"/)
  assert.match(journeyDetail, /journey\.template === "trial_signup"\) return "Browser \+ email \+ cleanup"/)
  assert.match(journeyServer, /template === "trial_signup"[\s\S]*?"Browser \+ email \+ cleanup"/)
})

test("pricing and entitlement copy does not imply Trial signup or email proof is available on Free", () => {
  const plans = readFileSync("src/lib/billing/plans.ts", "utf8")
  const pricing = readFileSync("src/sections/pricing.tsx", "utf8")
  const documentation = readFileSync("docs/business-evals/PRICING_AND_ENTITLEMENTS.md", "utf8")

  assert.match(plans, /browser-only Lead form/)
  assert.match(pricing, /Free covers one browser-only Lead form journey/)
  assert.match(pricing, /paid plans add Trial signup, email proof/)
  assert.match(documentation, /Trial signup and every email assertion require a paid entitlement/)
})

test("link-styled eval buttons preserve native link semantics", () => {
  for (const file of [
    "src/components/evals/evals-route-boundary.tsx",
    "src/components/evals/pages/eval-runs-pages.tsx",
    "src/components/evals/pages/incidents-pages.tsx",
    "src/components/evals/pages/journey-detail-page.tsx",
    "src/components/evals/pages/journeys-pages.tsx",
    "src/components/evals/pages/onboarding-page.tsx",
    "src/components/evals/pages/projects-pages.tsx",
    "src/components/evals/pages/reports-pages.tsx",
  ]) {
    const source = readFileSync(file, "utf8")
    for (const button of source.matchAll(/<Button\b[^>]*render=\{<Link\b[^>]*>/g)) {
      assert.match(button[0], /nativeButton=\{false\}/, `${file} renders a Link through Button without nativeButton={false}`)
    }
  }
})
