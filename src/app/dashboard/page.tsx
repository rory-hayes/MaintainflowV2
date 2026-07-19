import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { isBusinessEvalsUiEnabled } from "@/lib/features/business-evals"
import { redirect } from "next/navigation"

export default function DashboardPage() {
  const businessEvalsEnabled = isBusinessEvalsUiEnabled()
    || Boolean(process.env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST?.trim())
    || (process.env.NODE_ENV !== "production" && process.env.BUSINESS_EVALS_PREVIEW === "1")
  if (businessEvalsEnabled) redirect("/projects")
  return <ProtectedScreenPage screenKey="overview" />
}
