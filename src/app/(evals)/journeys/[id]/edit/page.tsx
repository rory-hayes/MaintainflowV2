import { JourneyFormPage } from "@/components/evals/pages/journeys-pages"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <JourneyFormPage journeyId={id} />
}
