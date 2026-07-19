import { authorizeOpsRequest } from "@/lib/ops/admin-auth.server"
import { loadOpsHealth } from "@/lib/ops/health.server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const auth = await authorizeOpsRequest(request.headers.get("authorization"))
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.message }, { status: auth.status })
  }

  try {
    const health = await loadOpsHealth({ adminEmail: auth.user.email })
    return NextResponse.json(health, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Ops health could not be loaded.",
      },
      { status: 500 }
    )
  }
}
