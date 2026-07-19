import { NextRequest, NextResponse } from "next/server"

import { assertUuid, businessEvalsErrorResponse, BusinessEvalsApiError, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import { createEvalEvidenceSignedUrl, isEvalEvidencePathForWorkspace } from "@/lib/runner/evidence-storage.server"
import { supabaseServiceJson } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ id: string; artifactId: string }> }
type Row = Record<string, unknown>

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const auth = await requireBusinessEvalsAuth(request)
    const { id, artifactId } = await params
    const evalRunId = assertUuid(id, "eval-run ID")
    const evidenceId = assertUuid(artifactId, "evidence ID")
    const rows = await supabaseServiceJson<Row[]>(`evidence_artifacts?${new URLSearchParams({
      select: "id,storage_path,expires_at",
      agency_id: `eq.${auth.workspace.id}`,
      eval_run_id: `eq.${evalRunId}`,
      id: `eq.${evidenceId}`,
      limit: "1",
    })}`)
    const artifact = rows[0]
    if (!artifact) throw new BusinessEvalsApiError(404, "EVIDENCE_NOT_FOUND", "Evidence artifact not found.")
    if (new Date(String(artifact.expires_at)).getTime() <= Date.now()) {
      throw new BusinessEvalsApiError(410, "EVIDENCE_EXPIRED", "This evidence artifact has reached its retention limit.")
    }
    const storagePath = String(artifact.storage_path)
    if (!isEvalEvidencePathForWorkspace(storagePath, auth.workspace.id)) {
      throw new BusinessEvalsApiError(403, "EVIDENCE_ACCESS_DENIED", "The evidence path does not belong to this workspace.")
    }
    return NextResponse.json({
      ok: true,
      data: { url: await createEvalEvidenceSignedUrl(storagePath, 300), expiresInSeconds: 300 },
    })
  } catch (error) {
    return businessEvalsErrorResponse(error)
  }
}
