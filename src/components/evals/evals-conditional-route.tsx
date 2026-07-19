import { isBusinessEvalsUiEnabled } from "@/lib/features/business-evals"
import type { ReactNode } from "react"
import { CoreLoopProvider } from "@/components/app/core-loop-provider"
import { EvalsAppShell } from "./evals-app-shell"
import { EvalsRouteBoundary } from "./evals-route-boundary"

export function EvalsConditionalRoute({ children, legacy }: { children: ReactNode; legacy: ReactNode }) {
  const previewEnabled = process.env.NODE_ENV !== "production" && process.env.BUSINESS_EVALS_PREVIEW === "1"
  if (previewEnabled) {
    return <EvalsRouteBoundary previewEnabled><EvalsAppShell>{children}</EvalsAppShell></EvalsRouteBoundary>
  }
  const globallyEnabled = isBusinessEvalsUiEnabled()
  const cohortConfigured = Boolean(process.env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST?.trim())
  const legacyWithProvider = <CoreLoopProvider>{legacy}</CoreLoopProvider>
  if (!globallyEnabled && !cohortConfigured) return legacyWithProvider
  return <EvalsRouteBoundary disabledFallback={legacyWithProvider}><EvalsAppShell>{children}</EvalsAppShell></EvalsRouteBoundary>
}
