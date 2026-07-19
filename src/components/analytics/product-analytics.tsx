"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { trackProductEvent } from "@/lib/analytics/product-events"
import { usePathname } from "next/navigation"
import { useEffect } from "react"

export function ProductAnalytics() {
  const pathname = usePathname()
  const { ready, user, authMode } = useAuth()

  useEffect(() => {
    if (!ready || !user || !pathname || pathname.startsWith("/share/reports/")) return

    trackProductEvent({
      eventName: "page_view",
      route: pathname,
      metadata: {
        authMode,
      },
    })
  }, [authMode, pathname, ready, user])

  return null
}
