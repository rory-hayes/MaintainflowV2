import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"
import { isBusinessEvalsUiEnabled } from "@/lib/features/business-evals"
import { isBusinessEvalsPreviewEnabled } from "@/lib/features/business-evals-preview.server"
import { redirect } from "next/navigation"

export default async function DashboardPage() {
  const businessEvalsEnabled = isBusinessEvalsUiEnabled()
    || await isBusinessEvalsPreviewEnabled()
  if (businessEvalsEnabled) redirect("/projects")

  const legacyDashboard = <ProtectedScreenPage screenKey="overview" />
  if (!process.env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST?.trim()) return legacyDashboard

  return <LegacyRouteRedirect destination="/projects">{legacyDashboard}</LegacyRouteRedirect>
}
