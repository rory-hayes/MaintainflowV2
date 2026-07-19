"use client"

import { normalizeProductEvent, type ProductEventMetadata, type ProductEventName } from "@/lib/analytics/product-events.shared"
import { getSupabaseAccessToken } from "@/lib/supabase/auth"

const PRODUCT_ANALYTICS_SESSION_KEY = "maintain-flow-analytics-session"

export function trackProductEvent(input: {
  eventName: ProductEventName
  agencyId?: string | null
  route?: string
  metadata?: ProductEventMetadata
}) {
  if (typeof window === "undefined") return

  const token = getSupabaseAccessToken()
  if (!token) return

  const payload = normalizeProductEvent({
    ...input,
    route: input.route ?? window.location.pathname,
    metadata: {
      ...input.metadata,
      sessionId: productAnalyticsSessionId(),
    },
  })
  if (!payload.eventName) return

  void fetch("/api/telemetry/event", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    keepalive: true,
    body: JSON.stringify(payload),
  }).catch(() => undefined)
}

function productAnalyticsSessionId() {
  try {
    const existing = window.localStorage.getItem(PRODUCT_ANALYTICS_SESSION_KEY)
    if (existing) return existing
    const next = crypto.randomUUID()
    window.localStorage.setItem(PRODUCT_ANALYTICS_SESSION_KEY, next)
    return next
  } catch {
    return ""
  }
}
