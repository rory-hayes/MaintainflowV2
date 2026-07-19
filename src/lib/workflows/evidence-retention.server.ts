import "server-only"

import { EVAL_EVIDENCE_BUCKET, isEvalEvidencePathForWorkspace } from "@/lib/runner/evidence-storage.server"
import { getSupabaseServerConfig, supabaseServiceJson } from "@/lib/supabase/server"

type EvidenceRow = {
  id: string
  agency_id: string
  storage_path: string
}

export async function purgeExpiredEvalEvidence(maxBatch = 50) {
  const rows = await supabaseServiceJson<EvidenceRow[]>(`evidence_artifacts?${new URLSearchParams({
    select: "id,agency_id,storage_path",
    expires_at: `lte.${new Date().toISOString()}`,
    order: "expires_at.asc,id.asc",
    limit: String(Math.max(1, Math.min(maxBatch, 200))),
  })}`)
  const validRows = rows.filter((row) => isEvalEvidencePathForWorkspace(row.storage_path, row.agency_id))
  if (!validRows.length) return { considered: rows.length, deleted: 0, invalidPaths: rows.length }

  const config = getSupabaseServerConfig()
  const storageResponse = await fetch(`${config.supabaseUrl}/storage/v1/object/${EVAL_EVIDENCE_BUCKET}`, {
    method: "DELETE",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: validRows.map((row) => row.storage_path) }),
  })
  if (!storageResponse.ok) {
    const detail = await storageResponse.text().catch(() => "")
    throw new Error(detail || "Expired eval evidence could not be removed from private storage.")
  }

  const ids = validRows.map((row) => row.id)
  const deleted = await supabaseServiceJson<EvidenceRow[]>(`evidence_artifacts?${new URLSearchParams({
    id: `in.(${ids.join(",")})`,
    expires_at: `lte.${new Date().toISOString()}`,
    select: "id,agency_id,storage_path",
  })}`, { method: "DELETE" })
  return { considered: rows.length, deleted: deleted.length, invalidPaths: rows.length - validRows.length }
}
