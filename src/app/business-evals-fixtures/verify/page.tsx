import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { ControlledFixtureVerification } from "@/components/evals/controlled-fixture-page"
import { isControlledFixtureEnabled } from "@/lib/evals/controlled-fixtures"
import { verifyControlledFixtureToken } from "@/lib/evals/controlled-fixture-token.server"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Controlled Fixture Verification | Maintain Flow",
  robots: { index: false, follow: false },
}

export default async function BusinessEvalFixtureVerificationRoute({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (!isControlledFixtureEnabled()) notFound()
  const token = (await searchParams).token ?? ""
  const payload = verifyControlledFixtureToken(token)
  if (!payload || !["healthy-trial", "cleanup-failure", "malicious-link"].includes(payload.scenario)) notFound()
  return <ControlledFixtureVerification scenario={payload.scenario as "healthy-trial" | "cleanup-failure" | "malicious-link"} />
}
