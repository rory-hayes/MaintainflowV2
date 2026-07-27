import { isAuthorizedCronRequest } from "@/lib/core/cron-auth"
import { BoundedJsonRequestError, readOptionalBoundedJson } from "@/lib/http/bounded-json.server"
import {
  BROWSERBASE_CONTEXT_CLEANUP_DEFAULT_BATCH_SIZE,
  boundedBrowserbaseContextCleanupBatchSize,
  runBrowserbaseContextCleanupJanitor,
} from "@/lib/runner/browserbase-context-cleanup.server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await readOptionalBoundedJson(request, 2_048)
    const requestedBatch = process.env.BROWSER_CONTEXT_CLEANUP_BATCH_SIZE
      ?? (isRecord(body) ? body.batchSize : undefined)
      ?? BROWSERBASE_CONTEXT_CLEANUP_DEFAULT_BATCH_SIZE
    const cleanup = await runBrowserbaseContextCleanupJanitor({
      batchSize: boundedBrowserbaseContextCleanupBatchSize(requestedBatch),
    })
    return NextResponse.json({
      claimed: cleanup.claimed,
      deleted: cleanup.deleted,
      retryScheduled: cleanup.retryScheduled,
      persistenceFailed: cleanup.persistenceFailed,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof BoundedJsonRequestError ? error.message : "Browser Context cleanup could not be processed." },
      { status: error instanceof BoundedJsonRequestError ? error.status : 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
