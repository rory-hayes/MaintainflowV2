import { JourneyDetailPage } from "@/components/evals/pages/journey-detail-page"
import { notFound } from "next/navigation"

export default function Page() {
  if (process.env.NODE_ENV === "production" || process.env.BUSINESS_EVALS_PREVIEW !== "1") notFound()
  return <JourneyDetailPage journeyId="trial-signup" />
}
