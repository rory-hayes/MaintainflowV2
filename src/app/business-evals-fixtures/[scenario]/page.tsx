import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { ControlledFixturePage } from "@/components/evals/controlled-fixture-page"
import { controlledFixtureScenario, isControlledFixtureEnabled } from "@/lib/evals/controlled-fixtures"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Controlled Business Eval Fixture | Maintain Flow",
  robots: { index: false, follow: false },
}

export default async function BusinessEvalFixtureRoute({ params }: { params: Promise<{ scenario: string }> }) {
  if (!isControlledFixtureEnabled()) notFound()
  const scenario = controlledFixtureScenario((await params).scenario)
  if (!scenario) notFound()
  return <ControlledFixturePage scenario={scenario} />
}
