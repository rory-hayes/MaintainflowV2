import { isBusinessEvalsUiEnabled } from "@/lib/features/business-evals"
import { isBusinessEvalsPreviewEnabled } from "@/lib/features/business-evals-preview.server"
import { Suspense, type ReactNode } from "react"
import { CoreLoopProvider } from "@/components/app/core-loop-provider"
import { EvalsAppShell } from "./evals-app-shell"
import { EvalsRouteBoundary } from "./evals-route-boundary"
import { EvalsRouteFallback } from "./evals-route-fallback"

export async function EvalsConditionalRoute({ children, legacy }: { children: ReactNode; legacy: ReactNode }) {
  const previewEnabled = await isBusinessEvalsPreviewEnabled()
  if (previewEnabled) {
    return (
      <Suspense fallback={<EvalsRouteFallback />}>
        <EvalsRouteBoundary previewEnabled><EvalsAppShell>{children}</EvalsAppShell></EvalsRouteBoundary>
      </Suspense>
    )
  }
  const globallyEnabled = isBusinessEvalsUiEnabled()
  const cohortConfigured = Boolean(process.env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST?.trim())
  const legacyWithProvider = <CoreLoopProvider>{legacy}</CoreLoopProvider>
  if (!globallyEnabled && !cohortConfigured) return legacyWithProvider
  return (
    <Suspense fallback={<EvalsRouteFallback />}>
      <EvalsRouteBoundary disabledFallback={legacyWithProvider}><EvalsAppShell>{children}</EvalsAppShell></EvalsRouteBoundary>
    </Suspense>
  )
}
