import { JourneyDetailPage } from "@/components/evals/pages/journey-detail-page"
import { isBusinessEvalsPreviewEnabled } from "@/lib/features/business-evals-preview.server"
import { notFound } from "next/navigation"

export default async function Page() {
  if (!(await isBusinessEvalsPreviewEnabled())) notFound()
  return <JourneyDetailPage journeyId="trial-signup" />
}
