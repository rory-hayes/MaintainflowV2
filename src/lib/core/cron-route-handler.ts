import { isAuthorizedCronRequest } from "./cron-auth.ts"

type CronRunner = (input: { batchSize: number; leaseSeconds: number }) => Promise<unknown>
type CronRouteResponse = {
  status: number
  body: Record<string, unknown> & { ok: boolean }
}

export async function handleRunChecksCronRequest(input: {
  authorizationHeader: string | null
  secret: string | undefined
  body: unknown
  defaultBatchSize?: string | number
  defaultLeaseSeconds?: string | number
  runner: CronRunner
}): Promise<CronRouteResponse> {
  if (!isAuthorizedCronRequest(input.authorizationHeader, input.secret)) {
    return {
      status: 401,
      body: { ok: false, error: "Unauthorized" },
    }
  }

  try {
    const requestedBatchSize = Number(readBodyValue(input.body, "batchSize") ?? input.defaultBatchSize ?? 5)
    const requestedLeaseSeconds = Number(input.defaultLeaseSeconds ?? 180)
    const summary = await input.runner({
      // Each worker runs one bounded wave. Five 30-second endpoint checks can run
      // concurrently while leaving the 60-second route/transport window for
      // atomic persistence and lease cleanup.
      batchSize: Number.isFinite(requestedBatchSize) ? Math.max(1, Math.min(requestedBatchSize, 5)) : 5,
      leaseSeconds: Number.isFinite(requestedLeaseSeconds)
        ? Math.max(120, Math.min(requestedLeaseSeconds, 900))
        : 180,
    })

    return {
      status: 200,
      body: {
        ok: true,
        ranAt: new Date().toISOString(),
        ...(summary && typeof summary === "object" ? summary : {}),
      },
    }
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        error: error instanceof Error ? error.message : "Scheduled checks failed.",
      },
    }
  }
}

function readBodyValue(body: unknown, key: string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined
  }

  return (body as Record<string, unknown>)[key]
}
