import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { EvalsConditionalRoute } from "@/components/evals/evals-conditional-route"
import { ReportsPage as BusinessEvalsReportsPage } from "@/components/evals/pages/reports-pages"

export default function ReportsPage() {
  return <EvalsConditionalRoute legacy={<ProtectedScreenPage screenKey="reports" />}><BusinessEvalsReportsPage /></EvalsConditionalRoute>
}
