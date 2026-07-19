import { PublicReportPage } from "@/components/evals/pages/reports-pages"
import type { Metadata } from "next"

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <PublicReportPage token={token} />
}
