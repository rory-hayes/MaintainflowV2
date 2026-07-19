import { NextRequest } from "next/server"

import { assertUuid, businessEvalsErrorResponse } from "@/lib/api/business-evals-auth.server"
import { loadSharedReportEvidence } from "@/lib/api/report-sharing.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ token: string; artifactId: string }> }

export async function GET(_request: NextRequest, { params }: Context) {
  try {
    const { token, artifactId } = await params
    const evidence = await loadSharedReportEvidence(token, assertUuid(artifactId, "evidence ID"))
    return new Response(evidence.body, {
      headers: {
        "Content-Type": evidence.contentType,
        ...(evidence.byteSize > 0 ? { "Content-Length": String(evidence.byteSize) } : {}),
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
