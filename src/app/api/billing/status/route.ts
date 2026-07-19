import { NextResponse, type NextRequest } from "next/server"

import { getStripeBillingStatus } from "@/lib/billing/stripe"
import {
  BillingAuthenticationError,
  BillingWorkspaceRequiredError,
  loadBillingWorkspaceForToken,
} from "@/lib/billing/workspace.server"
import { bearerToken } from "@/lib/supabase/report-download.server"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return NextResponse.json({ error: "Sign in before checking billing." }, { status: 401 })
  }

  try {
    await loadBillingWorkspaceForToken(token, request.headers.get("x-maintainflow-workspace-id"))
    return NextResponse.json(getStripeBillingStatus(), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Billing status could not be loaded." },
      {
        status: error instanceof BillingAuthenticationError
          ? 401
          : error instanceof BillingWorkspaceRequiredError
            ? 409
            : 500,
      }
    )
  }
}
