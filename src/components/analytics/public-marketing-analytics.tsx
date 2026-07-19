"use client"

import {
  isPublicMarketingRoute,
  normalizePublicMarketingEvent,
  type SignupCtaPlacement,
  type PublicMarketingEvent,
  type PublicMarketingRoute,
} from "@/lib/analytics/public-marketing-events.shared"
import { usePathname } from "next/navigation"
import { useEffect, useRef } from "react"

const endpoint = "/api/telemetry/public-event"

export function PublicMarketingAnalytics() {
  const pathname = usePathname()
  const lastViewedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!isPublicMarketingRoute(pathname)) {
      lastViewedPath.current = null
      return
    }
    if (lastViewedPath.current === pathname) return
    lastViewedPath.current = pathname
    sendPublicMarketingEvent({ eventName: "public_page_view", route: pathname, placement: null })
  }, [pathname])

  useEffect(() => {
    if (!isPublicMarketingRoute(pathname)) return

    function handleSignupCtaClick(event: MouseEvent) {
      const target = event.target
      if (!(target instanceof Element)) return

      const anchor = target.closest<HTMLAnchorElement>("a[data-signup-cta]")
      const placement = anchor?.dataset.signupCta
      if (!anchor || !placement || !isSignUpTarget(anchor)) return

      sendPublicMarketingEvent({
        eventName: "signup_cta_clicked",
        route: pathname as PublicMarketingRoute,
        placement: placement as SignupCtaPlacement,
      })
    }

    document.addEventListener("click", handleSignupCtaClick, { capture: true })
    return () => document.removeEventListener("click", handleSignupCtaClick, { capture: true })
  }, [pathname])

  return null
}

function isSignUpTarget(anchor: HTMLAnchorElement) {
  try {
    const target = new URL(anchor.href, window.location.origin)
    return target.origin === window.location.origin && target.pathname === "/sign-up"
  } catch {
    return false
  }
}

function sendPublicMarketingEvent(input: PublicMarketingEvent) {
  const event = normalizePublicMarketingEvent(input)
  if (!event) return

  void fetch(endpoint, {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => undefined)
}
