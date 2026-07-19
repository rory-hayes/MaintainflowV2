import "server-only"

import { queueFinalizedEvalAlerts } from "@/lib/api/alerts.server"

export async function queueFinalizedEvalAlertsStep(input: {
  agencyId: string
  evalRunId: string
  incidentId?: string | null
}) {
  "use step"
  return queueFinalizedEvalAlerts(input)
}
