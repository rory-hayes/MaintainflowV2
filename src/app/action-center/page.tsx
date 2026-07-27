import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default function ActionCenterPage() {
  return <LegacyRouteRedirect destination="/incidents"><ProtectedScreenPage screenKey="action-center" /></LegacyRouteRedirect>
}
