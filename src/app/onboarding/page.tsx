import { ProtectedScreenPage } from "@/components/app/protected-screen-page"
import { EvalsConditionalRoute } from "@/components/evals/evals-conditional-route"
import { EvalsOnboardingPage } from "@/components/evals/pages/onboarding-page"
import type { Metadata } from "next"

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default function OnboardingPage() {
  return <EvalsConditionalRoute legacy={<ProtectedScreenPage screenKey="onboarding" />}><EvalsOnboardingPage /></EvalsConditionalRoute>
}
