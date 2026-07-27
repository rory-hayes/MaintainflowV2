import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default function SettingsPage() {
  return <LegacyRouteRedirect destination="/settings/workspace"><ProtectedScreenPage screenKey="settings" /></LegacyRouteRedirect>
}
