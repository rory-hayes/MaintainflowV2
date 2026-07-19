import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <LegacyRouteRedirect destination={`/journeys/${encodeURIComponent(id)}`}><ProtectedScreenPage screenKey="workflow-detail" entityId={id} /></LegacyRouteRedirect>
}
