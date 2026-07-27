import { EvalsAppShell } from "@/components/evals/evals-app-shell"
import { EvalsRouteBoundary } from "@/components/evals/evals-route-boundary"
import { EvalsRouteFallback } from "@/components/evals/evals-route-fallback"
import { isBusinessEvalsUiEnabled } from "@/lib/features/business-evals"
import { isBusinessEvalsPreviewEnabled } from "@/lib/features/business-evals-preview.server"
import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Suspense, type ReactNode } from "react"

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default async function EvalsLayout({ children }: { children: ReactNode }) {
  const globalEnabled = isBusinessEvalsUiEnabled()
  const cohortConfigured = Boolean(process.env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST?.trim())
  const previewEnabled = await isBusinessEvalsPreviewEnabled()
  if (!globalEnabled && !cohortConfigured && !previewEnabled) redirect("/dashboard")
  return (
    <Suspense fallback={<EvalsRouteFallback />}>
      <EvalsRouteBoundary previewEnabled={previewEnabled}>
        <EvalsAppShell>{children}</EvalsAppShell>
      </EvalsRouteBoundary>
    </Suspense>
  )
}
