import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { buildPublicAcquisitionMetrics, parseContentRangeCount } from "../src/lib/ops/health-utils.ts"

test("ops health parses PostgREST exact count headers", () => {
  assert.equal(parseContentRangeCount("0-0/12"), 12)
  assert.equal(parseContentRangeCount("*/0"), 0)
  assert.equal(parseContentRangeCount(null), null)
})

test("ops health reports privacy-safe signup acquisition counts without claiming unique visitors", () => {
  const metrics = buildPublicAcquisitionMetrics([
    { event_name: "public_page_view", route: "/", placement: null },
    { event_name: "public_page_view", route: "/sign-up", placement: null },
    { event_name: "public_page_view", route: "/", placement: null },
    { event_name: "signup_cta_clicked", route: "/", placement: "home_hero" },
    { event_name: "signup_cta_clicked", route: "/", placement: "home_hero" },
  ])

  assert.deepEqual(metrics, {
    pageViews: 3,
    ctaClicks: 2,
    signupPageViews: 1,
    ctaRate: 66.7,
    topRoutes: [
      { label: "/", count: 2 },
      { label: "/sign-up", count: 1 },
    ],
    topPlacements: [{ label: "home_hero", count: 2 }],
  })
})

test("ops health consumes aggregate acquisition rows without truncating counts", () => {
  const metrics = buildPublicAcquisitionMetrics([
    { event_name: "public_page_view", route: "/", placement: null, event_count: 4_900 },
    { event_name: "public_page_view", route: "/sign-up", placement: null, event_count: 100 },
    { event_name: "signup_cta_clicked", route: "/", placement: "home_pricing", event_count: 250 },
  ])

  assert.equal(metrics.pageViews, 5_000)
  assert.equal(metrics.ctaClicks, 250)
  assert.equal(metrics.signupPageViews, 100)
  assert.equal(metrics.ctaRate, 5)
})

test("ops health renders acquisition metrics as unknown when the aggregate RPC fails", () => {
  const healthSource = readFileSync("src/lib/ops/health.server.ts", "utf8")
  const consoleSource = readFileSync("src/components/ops/ops-console.tsx", "utf8")

  assert.match(healthSource, /metricsAvailable: publicAcquisitionRowsResult\.ok/)
  assert.match(consoleSource, /acquisition\.metricsAvailable \? acquisition\.pageViews : "Unknown"/)
  assert.match(consoleSource, /acquisition\.metricsAvailable \? acquisition\.ctaClicks : "Unknown"/)
  assert.match(consoleSource, /acquisition\.metricsAvailable \? acquisition\.signupPageViews : "Unknown"/)
  assert.match(consoleSource, /acquisition\.metricsAvailable \? formatRate\(acquisition\.ctaRate\) : "Unknown"/)
  assert.doesNotMatch(healthSource, /contact_sales_leads|founder_notification_status/)
  assert.doesNotMatch(consoleSource, /Legacy applications|Notification queue|Failed alerts/)
})
