import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default function IssuesPage() {
  return <LegacyRouteRedirect destination="/incidents"><ProtectedScreenPage screenKey="issues" /></LegacyRouteRedirect>
}
