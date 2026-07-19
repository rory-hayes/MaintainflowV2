import { NextRequest, NextResponse } from "next/server"

import { businessEvalsErrorResponse } from "@/lib/api/business-evals-auth.server"
import { loadSharedReport } from "@/lib/api/report-sharing.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ token: string }> }

export async function GET(_request: NextRequest, { params }: Context) {
  try {
    const { token } = await params
    const data = await loadSharedReport(token)
    return NextResponse.json({ ok: true, data }, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
