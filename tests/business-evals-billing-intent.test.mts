import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { readCheckoutBillingSelection } from "../src/lib/billing/plans.ts"

test("billing selection accepts only self-serve paid plans and supported intervals", () => {
  assert.deepEqual(
    readCheckoutBillingSelection(new URLSearchParams("plan=scale&interval=annual")),
    { plan: "scale", interval: "annual" }
  )
  assert.deepEqual(
    readCheckoutBillingSelection(new URLSearchParams("plan=agency_plus&interval=weekly")),
    { plan: null, interval: "monthly" }
  )
  assert.deepEqual(
    readCheckoutBillingSelection(new URLSearchParams("plan=free&interval=annual")),
    { plan: null, interval: "annual" }
  )
})

test("onboarding converts public pricing intent into the internal billing selection", () => {
  const onboarding = readFileSync("src/components/evals/pages/onboarding-page.tsx", "utf8")

  assert.match(onboarding, /internalBillingPlanId\(intent\.plan\)/)
  assert.match(onboarding, /new URLSearchParams\(\{ plan: requestedBillingPlanId, interval: requestedInterval \}\)/)
  assert.match(onboarding, /href=\{`\/settings\/billing\?\$\{billingQuery\.toString\(\)\}`\}/)
})

test("billing visibly preserves the selected plan and interval without automatic checkout", () => {
  const settings = readFileSync("src/components/evals/pages/settings-pages.tsx", "utf8")

  assert.match(settings, /readCheckoutBillingSelection\(searchParams\)/)
  assert.match(settings, /Selected from pricing/)
  assert.match(settings, /selectedPlanDetails\.name/)
  assert.match(settings, /interval === "annual" \? "Annual" : "Monthly"/)
  assert.match(settings, /Stripe checkout opens only after you choose the plan button\./)
  assert.match(settings, /onClick=\{\(\) => openCheckout\(plan\.id(?: as CheckoutBillingPlanId)?\)\}/)
  assert.doesNotMatch(settings, /useEffect\([\s\S]{0,300}openCheckout/)
})
