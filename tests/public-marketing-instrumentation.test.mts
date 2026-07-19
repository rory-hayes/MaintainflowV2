import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const tracker = readFileSync("src/components/analytics/public-marketing-analytics.tsx", "utf8")
const endpoint = readFileSync("src/app/api/telemetry/public-event/route.ts", "utf8")

test("public marketing analytics is root-mounted and privacy bounded", () => {
  const layout = readFileSync("src/app/layout.tsx", "utf8")

  assert.match(layout, /<PublicMarketingAnalytics \/>/)
  assert.match(tracker, /credentials: "omit"/)
  assert.match(tracker, /referrerPolicy: "no-referrer"/)
  assert.match(tracker, /cache: "no-store"/)
  assert.match(tracker, /keepalive: true/)
  assert.match(tracker, /a\[data-signup-cta\]/)
  assert.match(tracker, /target\.pathname === "\/sign-up"/)
  assert.doesNotMatch(tracker, /data-pilot-cta|pilot_cta_clicked|contact-sales/)
  assert.match(tracker, /lastViewedPath\.current = null/)
  assert.match(tracker, /return null/)

  for (const forbidden of [
    "document.referrer",
    "location.search",
    "localStorage",
    "sessionStorage",
    "document.cookie",
    "navigator.userAgent",
    "crypto.randomUUID",
  ]) {
    assert.doesNotMatch(tracker, new RegExp(forbidden.replace(".", "\\.")))
  }
})

test("every public marketing CTA has a stable placement", () => {
  const navigation = readFileSync("src/sections/navigation.tsx", "utf8")
  const landing = readFileSync("src/sections/business-evals-landing.tsx", "utf8")
  const pricing = readFileSync("src/sections/pricing.tsx", "utf8")
  const footer = readFileSync("src/sections/footer.tsx", "utf8")
  const eventContract = readFileSync("src/lib/analytics/public-marketing-events.shared.ts", "utf8")
  const sources = [navigation, landing, pricing, footer].join("\n")

  assert.match(sources, /data-signup-cta/)
  assert.doesNotMatch(sources, /data-pilot-cta/)
  assert.match(pricing, /data-signup-cta=\{`home_pricing_\$\{signupPlan\}`\}/)
  assert.match(landing, /data-signup-cta=\{`home_template_\$\{title === "Lead form" \? "lead" : "trial"\}`\}/)

  for (const placement of [
    "nav_desktop",
    "nav_mobile",
    "home_hero",
    "home_pricing_free",
    "home_pricing_solo",
    "home_pricing_team",
    "home_pricing_agency",
    "home_template_lead",
    "home_template_trial",
    "home_closing",
    "footer_company",
  ]) {
    assert.match(eventContract, new RegExp(`"${placement}"`))
  }
})

test("public endpoint is same-origin, bounded, rate-limited, and writes no identity data", () => {
  assert.match(endpoint, /maxBodyBytes = 1_024/)
  assert.match(endpoint, /isSameOriginBrowserRequest/)
  assert.match(endpoint, /PUBLIC_TELEMETRY_ENABLED === "true"/)
  assert.match(endpoint, /VERCEL_ENV === "production"/)
  assert.match(endpoint, /new URL\(siteUrl\)\.origin/)
  assert.match(endpoint, /AbortSignal\.timeout\(2_000\)/)
  assert.match(endpoint, /createFixedWindowRateLimiter\(\{ limit: 600/)
  assert.match(endpoint, /rpc\/record_public_acquisition_event/)
  assert.match(endpoint, /p_event_name: event\.eventName/)
  assert.match(endpoint, /p_route: event\.route/)
  assert.match(endpoint, /p_placement: event\.placement/)
  assert.doesNotMatch(endpoint, /agency_id|user_id|session_id|metadata_json|user-agent|referer|x-forwarded-for|createHash/)
})
