"use client"

import LenisWrapper from "@/components/common/lenis-wrapper"
import { authLightThemeStyle } from "@/components/auth/auth-light-theme"
import Footer from "@/sections/footer"
import Navigation from "@/sections/navigation"
import { usePathname } from "next/navigation"
import { type CSSProperties, type ReactNode } from "react"

const marketingLightThemeStyle = {
  ...authLightThemeStyle,
  "--background": "oklch(1 0 0)",
} as CSSProperties

export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const appRoutePrefixes = [
    "/control-room",
    "/dashboard",
    "/action-center",
    "/clients",
    "/projects",
    "/workflows",
    "/journeys",
    "/checks",
    "/eval-runs",
    "/evals-preview",
    "/issues",
    "/incidents",
    "/reports",
    "/share/reports",
    "/settings",
    "/onboarding",
  ]
  const authRoutePrefixes = [
    "/login",
    "/signup",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
  ]
  const isAppRoute = [...appRoutePrefixes, ...authRoutePrefixes].some((prefix) =>
    pathname?.startsWith(prefix)
  )

  if (isAppRoute) {
    return <main className="min-h-screen overflow-hidden">{children}</main>
  }

  return (
    <LenisWrapper>
      <div className="min-h-screen bg-white text-slate-950" style={marketingLightThemeStyle}>
        <Navigation />
        <main className="min-h-screen overflow-hidden">{children}</main>
        <Footer />
      </div>
    </LenisWrapper>
  )
}
