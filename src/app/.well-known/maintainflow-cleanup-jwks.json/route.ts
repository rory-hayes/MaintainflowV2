import { NextResponse } from "next/server"

import { cleanupWebhookJwk, loadCleanupSigningKey } from "@/lib/runner/cleanup-webhook-signing"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET() {
  try {
    return NextResponse.json(
      { keys: [cleanupWebhookJwk(loadCleanupSigningKey())] },
      {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        },
      }
    )
  } catch {
    return NextResponse.json({ error: "Cleanup verification keys are not configured." }, { status: 503 })
  }
}
