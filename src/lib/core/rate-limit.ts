type RateLimitBucket = {
  count: number
  resetAt: number
}

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  resetAt: number
}

export function createFixedWindowRateLimiter({
  limit,
  windowMs,
  now = () => Date.now(),
}: {
  limit: number
  windowMs: number
  now?: () => number
}) {
  const buckets = new Map<string, RateLimitBucket>()

  return {
    check(key: string): RateLimitResult {
      const safeKey = key.trim() || "anonymous"
      const currentTime = now()
      const existing = buckets.get(safeKey)
      const bucket = existing && existing.resetAt > currentTime
        ? existing
        : { count: 0, resetAt: currentTime + windowMs }

      bucket.count += 1
      buckets.set(safeKey, bucket)

      return {
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: bucket.resetAt,
      }
    },
    clear() {
      buckets.clear()
    },
  }
}
