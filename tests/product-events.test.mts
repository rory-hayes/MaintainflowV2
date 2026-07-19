import assert from "node:assert/strict"
import test from "node:test"

import {
  normalizeProductEvent,
  sanitizeProductEventMetadata,
} from "../src/lib/analytics/product-events.shared.ts"

test("product events accept only known event names and internal routes", () => {
  assert.deepEqual(
    normalizeProductEvent({
      eventName: "workflow_created",
      agencyId: "00000000-0000-4000-8000-000000000001",
      route: "/workflows?add=workflow",
      metadata: { method: "GET" },
    }),
    {
      eventName: "workflow_created",
      agencyId: "00000000-0000-4000-8000-000000000001",
      route: "/workflows?add=workflow",
      metadata: { method: "GET" },
    }
  )

  assert.equal(normalizeProductEvent({ eventName: "unknown_event" }).eventName, null)
  assert.equal(normalizeProductEvent({ eventName: "page_view", route: "https://example.com" }).route, "")
  assert.equal(normalizeProductEvent({ eventName: "page_view", agencyId: "not-a-uuid" }).agencyId, null)
})

test("product event metadata is flattened and bounded", () => {
  const metadata = sanitizeProductEventMetadata({
    "bad key": "x".repeat(300),
    attempts: 2,
    enabled: true,
    nested: { secret: "nope" },
    invalidNumber: Number.NaN,
  })

  assert.equal(metadata.bad_key, "x".repeat(240))
  assert.equal(metadata.attempts, 2)
  assert.equal(metadata.enabled, true)
  assert.equal(metadata.nested, null)
  assert.equal(metadata.invalidNumber, null)
})

test("shared report tokens are removed from product analytics routes and metadata", () => {
  const token = "raw-secret-report-token"
  const event = normalizeProductEvent({
    eventName: "page_view",
    route: `/share/reports/${token}`,
    metadata: {
      nextPath: `/share/reports/${token}?from=notification`,
      absoluteUrl: `https://maintainflow.example/share/reports/${token}#evidence`,
    },
  })

  assert.equal(event.route, "/share/reports/[token]")
  assert.equal(event.metadata.nextPath, "/share/reports/[token]?from=notification")
  assert.equal(event.metadata.absoluteUrl, "https://maintainflow.example/share/reports/[token]#evidence")
  assert.doesNotMatch(JSON.stringify(event), new RegExp(token))
})
