import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <LegacyRouteRedirect destination={`/projects/${encodeURIComponent(id)}`}><ProtectedScreenPage screenKey="client-detail" entityId={id} /></LegacyRouteRedirect>
}
