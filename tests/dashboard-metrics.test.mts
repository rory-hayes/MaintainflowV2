import assert from "node:assert/strict"
import test from "node:test"

import { buildHealthTrendData } from "../src/lib/core/dashboard-metrics.ts"

test("dashboard health trend buckets stored check runs by day and status", () => {
  const trend = buildHealthTrendData(
    [
      { createdAt: "2026-06-26T09:00:00.000Z", evidenceOrigin: "service", status: "healthy" },
      { createdAt: "2026-06-26T11:00:00.000Z", evidenceOrigin: "service", status: "failed" },
      { createdAt: "2026-06-27T09:00:00.000Z", evidenceOrigin: "service", status: "degraded" },
      { createdAt: "2026-06-27T10:00:00.000Z", evidenceOrigin: "service", status: "skipped" },
      { createdAt: "2026-06-28T09:00:00.000Z", evidenceOrigin: "service", status: "healthy" },
      { createdAt: "2026-06-20T09:00:00.000Z", evidenceOrigin: "service", status: "failed" },
    ],
    { days: 3, referenceDate: "2026-06-28T15:00:00.000Z" }
  )

  assert.deepEqual(
    trend.map(({ key, healthy, attention, skipped, total, passRate }) => ({
      key,
      healthy,
      attention,
      skipped,
      total,
      passRate,
    })),
    [
      { key: "2026-06-26", healthy: 1, attention: 1, skipped: 0, total: 2, passRate: 50 },
      { key: "2026-06-27", healthy: 0, attention: 1, skipped: 1, total: 2, passRate: 0 },
      { key: "2026-06-28", healthy: 1, attention: 0, skipped: 0, total: 1, passRate: 100 },
    ]
  )
})

test("dashboard health trend returns empty buckets instead of fake chart data", () => {
  const trend = buildHealthTrendData([], { days: 2, referenceDate: "2026-06-28T15:00:00.000Z" })

  assert.deepEqual(
    trend.map(({ key, healthy, attention, skipped, total, passRate }) => ({
      key,
      healthy,
      attention,
      skipped,
      total,
      passRate,
    })),
    [
      { key: "2026-06-27", healthy: 0, attention: 0, skipped: 0, total: 0, passRate: 0 },
      { key: "2026-06-28", healthy: 0, attention: 0, skipped: 0, total: 0, passRate: 0 },
    ]
  )
})

test("dashboard health trend excludes legacy browser runs from assurance metrics", () => {
  const trend = buildHealthTrendData(
    [
      { createdAt: "2026-06-28T09:00:00.000Z", evidenceOrigin: "legacy_browser", status: "healthy" },
      { createdAt: "2026-06-28T10:00:00.000Z", evidenceOrigin: "service", status: "failed" },
    ],
    { days: 1, referenceDate: "2026-06-28T15:00:00.000Z" }
  )

  assert.deepEqual(trend[0], {
    key: "2026-06-28",
    label: "Jun 28",
    healthy: 0,
    attention: 1,
    skipped: 0,
    total: 1,
    passRate: 0,
  })
})
