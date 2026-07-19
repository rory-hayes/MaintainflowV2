import { JourneyDetailPage } from "@/components/evals/pages/journey-detail-page"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <JourneyDetailPage journeyId={id} />
}
