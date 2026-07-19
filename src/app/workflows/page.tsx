import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default function WorkflowsPage() {
  return <LegacyRouteRedirect destination="/journeys"><ProtectedScreenPage screenKey="workflows" /></LegacyRouteRedirect>
}
