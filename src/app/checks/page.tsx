import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default function ChecksPage() {
  return <LegacyRouteRedirect destination="/eval-runs"><ProtectedScreenPage screenKey="checks" /></LegacyRouteRedirect>
}
