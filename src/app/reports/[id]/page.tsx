import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { EvalsConditionalRoute } from "@/components/evals/evals-conditional-route"
import { ReportDetailPage as BusinessEvalsReportDetailPage } from "@/components/evals/pages/reports-pages"

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <EvalsConditionalRoute legacy={<ProtectedScreenPage screenKey="report-detail" entityId={id} />}><BusinessEvalsReportDetailPage reportId={id} /></EvalsConditionalRoute>
}
