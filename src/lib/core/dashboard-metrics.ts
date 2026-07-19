import { isServiceIssuedCheckRun } from "./evidence-provenance.ts"
import type { CheckRun } from "./types.ts"

export type HealthTrendPoint = {
  key: string
  label: string
  healthy: number
  attention: number
  skipped: number
  total: number
  passRate: number
}

type HealthTrendRun = Pick<CheckRun, "createdAt" | "evidenceOrigin" | "status">

type HealthTrendOptions = {
  days?: number
  referenceDate?: Date | string
}

export function buildHealthTrendData(
  runs: HealthTrendRun[],
  { days = 14, referenceDate = new Date() }: HealthTrendOptions = {}
): HealthTrendPoint[] {
  const windowDays = Math.max(1, Math.floor(days))
  const endDate = startOfUtcDay(new Date(referenceDate))
  const startDate = addUtcDays(endDate, -(windowDays - 1))
  const buckets = new Map<string, HealthTrendPoint>()

  for (let index = 0; index < windowDays; index += 1) {
    const date = addUtcDays(startDate, index)
    const key = utcDateKey(date)
    buckets.set(key, {
      key,
      label: trendLabel(date),
      healthy: 0,
      attention: 0,
      skipped: 0,
      total: 0,
      passRate: 0,
    })
  }

  runs.filter(isServiceIssuedCheckRun).forEach((run) => {
    const runDate = new Date(run.createdAt)
    if (Number.isNaN(runDate.getTime())) return

    const bucketDate = startOfUtcDay(runDate)
    if (bucketDate < startDate || bucketDate > endDate) return

    const bucket = buckets.get(utcDateKey(bucketDate))
    if (!bucket) return

    bucket.total += 1
    if (run.status === "healthy") {
      bucket.healthy += 1
    } else if (run.status === "skipped") {
      bucket.skipped += 1
    } else {
      bucket.attention += 1
    }
  })

  return Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    passRate: bucket.healthy + bucket.attention
      ? Math.round((bucket.healthy / (bucket.healthy + bucket.attention)) * 100)
      : 0,
  }))
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function trendLabel(date: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date)
}
