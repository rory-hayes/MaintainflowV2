import { EvalRunDetailPage } from "@/components/evals/pages/eval-runs-pages"

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <EvalRunDetailPage runId={id} />
}
