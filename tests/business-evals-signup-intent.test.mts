import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  internalBillingPlanId,
  onboardingPathForIntent,
  readPublicSignupIntent,
  signupHref,
} from "../src/lib/auth/signup-intent.ts"

test("public signup intent is allowlisted and survives the auth handoff", () => {
  const valid = new URLSearchParams("plan=agency&template=trial_signup&interval=annual")
  assert.deepEqual(readPublicSignupIntent(valid), {
    plan: "agency",
    template: "trial_signup",
    interval: "annual",
  })
  assert.equal(onboardingPathForIntent(valid), "/onboarding?plan=agency&template=trial_signup&interval=annual")
  assert.equal(
    signupHref({ plan: "team", template: "trial_signup", interval: "monthly" }),
    "/sign-up?plan=team&template=trial_signup&interval=monthly"
  )

  const malicious = new URLSearchParams("plan=enterprise&template=arbitrary_script&interval=weekly")
  assert.deepEqual(readPublicSignupIntent(malicious), { plan: null, template: null, interval: null })
  assert.equal(onboardingPathForIntent(malicious), "/onboarding")
  assert.equal(internalBillingPlanId("solo"), "starter")
  assert.equal(internalBillingPlanId("team"), "growth")
  assert.equal(internalBillingPlanId("agency"), "scale")
})

test("email confirmation and Google OAuth preserve the same safe onboarding path", () => {
  const authCard = readFileSync("src/components/auth/auth-card.tsx", "utf8")
  const authProvider = readFileSync("src/components/auth/auth-provider.tsx", "utf8")
  const supabaseAuth = readFileSync("src/lib/supabase/auth.ts", "utf8")

  assert.match(authCard, /onboardingPathForIntent\(params\)/)
  assert.match(authCard, /readPublicSignupIntent\(params\)/)
  assert.match(authCard, /checkout never opens and you are never charged automatically/)
  assert.match(authCard, /\{plan\}\{interval\} · \{template\} selected/)
  assert.match(authCard, /signUp\(\{ \.\.\.signupInput, nextPath \}\)/)
  assert.match(authCard, /signInWithGoogle\(\{ nextPath \}\)/)
  assert.match(authProvider, /nextPath\?: string/)
  assert.match(supabaseAuth, /signupRedirect\.searchParams\.set\("next", nextPath\)/)
  assert.match(supabaseAuth, /redirectTo\.searchParams\.set\("next", nextPath\)/)
})

test("first proof carries the selected template through project authorization into the journey builder", () => {
  const projects = readFileSync("src/components/evals/pages/projects-pages.tsx", "utf8")
  const journeys = readFileSync("src/components/evals/pages/journeys-pages.tsx", "utf8")

  assert.match(projects, /continuationTemplate=\{requestedTemplate\}/)
  assert.match(projects, /#project-authorization/)
  assert.match(projects, /previewMode[\s\S]*await createProject\(body\)/)
  assert.match(projects, /if \(previewMode\) router\.push\(href\)/)
  assert.match(projects, /if \(previewMode\) await authorizeProject\(project\.id, domains\)/)
  assert.match(projects, /window\.location\.assign\(newJourneyHref\)/)
  assert.match(journeys, /searchParams\.get\("template"\) === "trial_signup"/)
})

test("the disabled Business Evals rollback has a real legacy dashboard instead of a redirect loop", () => {
  const dashboard = readFileSync("src/app/dashboard/page.tsx", "utf8")
  const evalsLayout = readFileSync("src/app/(evals)/layout.tsx", "utf8")

  assert.match(evalsLayout, /redirect\("\/dashboard"\)/)
  assert.match(dashboard, /<ProtectedScreenPage screenKey="overview" \/>/)
  assert.match(dashboard, /if \(businessEvalsEnabled\) redirect\("\/projects"\)/)
})
