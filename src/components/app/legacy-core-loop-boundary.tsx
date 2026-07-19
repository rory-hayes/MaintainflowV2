"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

import { CoreLoopProvider } from "@/components/app/core-loop-provider"

const legacyPrefixes = [
  "/dashboard",
  "/action-center",
  "/clients",
  "/workflows",
  "/checks",
  "/issues",
  "/control-room",
]

export function LegacyCoreLoopBoundary({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const isLegacyRoute = pathname === "/settings"
    || legacyPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  return isLegacyRoute ? <CoreLoopProvider>{children}</CoreLoopProvider> : children
}
