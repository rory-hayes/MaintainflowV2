import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default function ClientsPage() {
  return <LegacyRouteRedirect destination="/projects"><ProtectedScreenPage screenKey="clients" /></LegacyRouteRedirect>
}
