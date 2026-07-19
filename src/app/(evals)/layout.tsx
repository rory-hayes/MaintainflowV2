import { EvalsAppShell } from "@/components/evals/evals-app-shell"
import { EvalsRouteBoundary } from "@/components/evals/evals-route-boundary"
import { isBusinessEvalsUiEnabled } from "@/lib/features/business-evals"
import type { Metadata } from "next"
import { redirect } from "next/navigation"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default function EvalsLayout({ children }: { children: ReactNode }) {
  const globalEnabled = isBusinessEvalsUiEnabled()
  const cohortConfigured = Boolean(process.env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST?.trim())
  const previewEnabled = process.env.NODE_ENV !== "production" && process.env.BUSINESS_EVALS_PREVIEW === "1"
  if (!globalEnabled && !cohortConfigured && !previewEnabled) redirect("/dashboard")
  return <EvalsRouteBoundary previewEnabled={previewEnabled}><EvalsAppShell>{children}</EvalsAppShell></EvalsRouteBoundary>
}
