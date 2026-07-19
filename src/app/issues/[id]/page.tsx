import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { LegacyRouteRedirect } from "@/components/evals/legacy-route-redirect"

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <LegacyRouteRedirect destination={`/incidents/${encodeURIComponent(id)}`}><ProtectedScreenPage screenKey="issue-detail" entityId={id} /></LegacyRouteRedirect>
}
