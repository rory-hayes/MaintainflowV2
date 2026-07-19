import assert from "node:assert/strict"
import test from "node:test"

import {
  normalizePublicMarketingEvent,
  publicMarketingRoutes,
} from "../src/lib/analytics/public-marketing-events.shared.ts"

test("public marketing events accept exact page routes without an identifier", () => {
  assert.ok(publicMarketingRoutes.includes("/sign-up"))
  assert.deepEqual(publicMarketingRoutes, ["/", "/sign-up", "/security", "/privacy", "/terms"])

  for (const route of publicMarketingRoutes) {
    assert.deepEqual(normalizePublicMarketingEvent({ eventName: "public_page_view", route }), {
      eventName: "public_page_view",
      route,
      placement: null,
    })
  }
})

test("signup CTA events enforce exact placement and source-route pairs", () => {
  assert.deepEqual(
    normalizePublicMarketingEvent({ eventName: "signup_cta_clicked", route: "/", placement: "home_hero" }),
    { eventName: "signup_cta_clicked", route: "/", placement: "home_hero" }
  )
  assert.deepEqual(
    normalizePublicMarketingEvent({ eventName: "signup_cta_clicked", route: "/", placement: "home_pricing_team" }),
    { eventName: "signup_cta_clicked", route: "/", placement: "home_pricing_team" }
  )
  assert.deepEqual(
    normalizePublicMarketingEvent({ eventName: "signup_cta_clicked", route: "/", placement: "home_template_trial" }),
    { eventName: "signup_cta_clicked", route: "/", placement: "home_template_trial" }
  )
  assert.deepEqual(
    normalizePublicMarketingEvent({ eventName: "signup_cta_clicked", route: "/terms", placement: "footer_company" }),
    { eventName: "signup_cta_clicked", route: "/terms", placement: "footer_company" }
  )

  assert.equal(
    normalizePublicMarketingEvent({ eventName: "signup_cta_clicked", route: "/terms", placement: "home_hero" }),
    null
  )
  assert.equal(
    normalizePublicMarketingEvent({ eventName: "signup_cta_clicked", route: "/security", placement: "home_hero" }),
    null
  )
})

test("public marketing events reject routes, internal events, and smuggled data", () => {
  const invalidInputs = [
    { eventName: "public_page_view", route: "/?utm_source=linkedin" },
    { eventName: "public_page_view", route: "/#pricing" },
    { eventName: "public_page_view", route: "https://www.maintainflow.io/" },
    { eventName: "public_page_view", route: "/dashboard" },
    { eventName: "public_page_view", route: "/agency-workflow-maintenance" },
    { eventName: "public_page_view", route: "/use-cases/n8n-maintenance" },
    { eventName: "workflow_created", route: "/" },
    { eventName: "public_page_view", route: "/", email: "buyer@example.com" },
    { eventName: "signup_cta_clicked", route: "/", placement: "home_hero", metadata: { email: "buyer@example.com" } },
    { eventName: "signup_cta_clicked", route: "/", placement: "unknown" },
    { eventName: "signup_cta_clicked", route: "/", placement: null },
    { eventName: "pilot_cta_clicked", route: "/", placement: "home_hero" },
  ]

  for (const input of invalidInputs) assert.equal(normalizePublicMarketingEvent(input), null)
})
