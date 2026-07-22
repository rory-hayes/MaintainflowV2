import "server-only"

import { headers } from "next/headers"

import { isBusinessEvalsPreviewRequestAllowed } from "@/lib/features/business-evals-preview-policy"

const e2ePreviewHeader = "x-maintainflow-e2e-preview-token"

export async function isBusinessEvalsPreviewEnabled(
  env: Partial<Record<string, string | undefined>> = process.env
) {
  // Production-mode fixture access exists only for the token-bound Playwright
  // acceptance build. Vercel deployments are denied even if test-only values
  // are accidentally copied into their environment.
  const presentedToken = env.NODE_ENV === "production"
    ? (await headers()).get(e2ePreviewHeader)
    : null
  return isBusinessEvalsPreviewRequestAllowed({ env, presentedToken })
}
