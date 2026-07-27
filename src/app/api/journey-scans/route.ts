import { NextRequest, NextResponse } from "next/server"

import { BusinessEvalsApiError, businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { journeyScanSchema, parseRequestJson } from "@/lib/api/business-evals-contracts"
import { enforceBusinessEvalRateLimits } from "@/lib/api/business-evals-rate-limit.server"
import { assertProjectAuthorizedForUrl } from "@/lib/api/projects.server"
import { scanJourneyPage } from "@/lib/runner/page-scan.server"
import { BrowserbaseUsageGuardError } from "@/lib/runner/browserbase-usage-control.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const auth = await requireBusinessEvalsAuth(request, { roles: ["owner", "admin"] })
    const input = await parseRequestJson(request, journeyScanSchema)
    const domain = new URL(input.url).hostname.toLowerCase()
    await enforceBusinessEvalRateLimits({
      userId: auth.user.id,
      workspaceId: auth.workspace.id,
      projectId: input.projectId,
      destinationDomain: domain,
    })
    const authorization = await assertProjectAuthorizedForUrl(auth.workspace.id, input.projectId, input.url)
    const scan = await scanJourneyPage({
      url: input.url,
      agencyId: auth.workspace.id,
      projectId: input.projectId,
      allowedHosts: authorization.allowedHosts,
    })
    return NextResponse.json({
      ok: true,
      data: {
        ...scan,
        template: input.template,
        projectId: input.projectId,
        approvedActionDomains: authorization.allowedHosts,
      },
    })
  } catch (error) {
    if (error instanceof BrowserbaseUsageGuardError) {
      return businessEvalsErrorResponse(new BusinessEvalsApiError(
        503,
        "BROWSER_CAPACITY_PAUSED",
        error.message
      ))
    }
    return businessEvalsErrorResponse(error)
  }
}
