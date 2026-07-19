import "server-only"

import { createHash } from "node:crypto"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { getBusinessEvalsEntitlement } from "@/lib/api/business-evals-entitlements.server"
import {
  deriveIdempotentReportShareToken,
  hashReportShareToken,
  hashReportSnapshot,
  isReportShareToken,
  reportSafeScreenshotIds,
  reportShareExpiry,
} from "@/lib/reports/share-links"
import { buildReportSafeContent } from "@/lib/reports/report-safe-contract"
import { isEvalEvidencePathForWorkspace, loadPrivateEvalArtifact } from "@/lib/runner/evidence-storage.server"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export async function createReportShareLink(input: {
  agencyId: string
  reportId: string
  userId: string
  expiresInHours: number
  idempotencyKey: string
  origin: string
}) {
  const pepper = getSharePepper()
  await assertPaidReportingEntitlement(input.agencyId)
  const reports = await supabaseServiceJson<Row[]>(`reports?${query({
    select: "id,status,snapshot_version,snapshot_json,stale_at,evidence_fingerprint,eval_evidence_fingerprint,eval_snapshot_idempotency_key",
    agency_id: `eq.${input.agencyId}`,
    id: `eq.${input.reportId}`,
    limit: "1",
  })}`)
  const report = reports[0]
  if (!report) throw new BusinessEvalsApiError(404, "REPORT_NOT_FOUND", "Report not found.")
  if (report.status !== "ready" || report.stale_at || Number(report.snapshot_version ?? 0) < 1) {
    throw new BusinessEvalsApiError(409, "REPORT_NOT_READY", "Refresh and approve the current report snapshot before sharing it.")
  }
  assertServiceIssuedEvalSnapshot(report)

  const token = deriveIdempotentReportShareToken({
    reportId: input.reportId,
    idempotencyKey: input.idempotencyKey,
    expiresInHours: input.expiresInHours,
    pepper,
  })
  const tokenHash = hashReportShareToken(token, pepper)
  const snapshotHash = hashReportSnapshot(report.snapshot_json ?? {})
  const expiresAt = reportShareExpiry(input.expiresInHours)
  let rows = await supabaseServiceJson<Row[]>("report_share_links?on_conflict=agency_id,idempotency_key", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: JSON.stringify({
      agency_id: input.agencyId,
      report_id: input.reportId,
      token_hash: tokenHash,
      idempotency_key: input.idempotencyKey,
      snapshot_version: Number(report.snapshot_version),
      evidence_fingerprint: String(report.evidence_fingerprint ?? ""),
      snapshot_hash: snapshotHash,
      expires_at: expiresAt,
      created_by_user_id: input.userId,
      revoked_at: null,
    }),
  })
  if (!rows[0]) {
    rows = await supabaseServiceJson<Row[]>(`report_share_links?${query({
      select: "id,report_id,token_hash,snapshot_version,evidence_fingerprint,snapshot_hash,expires_at,revoked_at",
      agency_id: `eq.${input.agencyId}`,
      idempotency_key: `eq.${input.idempotencyKey}`,
      limit: "1",
    })}`)
  }
  const link = rows[0]
  if (!link) throw new Error("Supabase did not return the report share link.")
  if (
    String(link.report_id) !== input.reportId
    || String(link.token_hash) !== tokenHash
    || Number(link.snapshot_version) !== Number(report.snapshot_version)
    || String(link.evidence_fingerprint) !== String(report.evidence_fingerprint)
    || String(link.snapshot_hash) !== snapshotHash
  ) {
    throw new BusinessEvalsApiError(409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for this report share link.")
  }
  if (link.revoked_at) {
    throw new BusinessEvalsApiError(409, "SHARE_LINK_REVOKED", "This idempotent share link was revoked. Use a new idempotency key.")
  }
  const shareUrl = new URL(`/share/reports/${token}`, input.origin)
  return {
    id: String(link.id),
    url: shareUrl.toString(),
    expiresAt: String(link.expires_at ?? expiresAt),
    snapshotVersion: Number(link.snapshot_version ?? report.snapshot_version),
  }
}

export async function revokeReportShareLink(input: {
  agencyId: string
  reportId: string
  linkId: string
  userId: string
  idempotencyKey: string
}) {
  const idempotencyKeyHash = hashRevocationValue(`report-share-revocation:${input.idempotencyKey}`)
  const requestHash = hashRevocationValue(JSON.stringify({
    operation: "report_share_link.revoke",
    agencyId: input.agencyId,
    reportId: input.reportId,
    linkId: input.linkId,
    userId: input.userId,
  }))
  let rows: Row[]
  try {
    rows = await supabaseServiceJson<Row[]>("rpc/revoke_report_share_link_idempotent", {
      method: "POST",
      body: JSON.stringify({
        p_agency_id: input.agencyId,
        p_report_id: input.reportId,
        p_share_link_id: input.linkId,
        p_requested_by_user_id: input.userId,
        p_idempotency_key_hash: idempotencyKeyHash,
        p_request_hash: requestHash,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("REPORT_SHARE_REVOCATION_IDEMPOTENCY_KEY_REUSED")) {
      throw new BusinessEvalsApiError(409, "IDEMPOTENCY_KEY_REUSED", "Use a new idempotency key for this report-share revocation.")
    }
    if (message.toLowerCase().includes("already revoked")) {
      throw new BusinessEvalsApiError(409, "SHARE_LINK_REVOKED", "This report share link is already revoked.")
    }
    if (message.toLowerCase().includes("not found")) {
      throw new BusinessEvalsApiError(404, "SHARE_LINK_NOT_FOUND", "Report share link not found.")
    }
    throw error
  }
  if (!rows[0]) throw new BusinessEvalsApiError(404, "SHARE_LINK_NOT_FOUND", "Report share link not found.")
  return { id: String(rows[0].share_link_id), revokedAt: String(rows[0].revoked_at) }
}

function hashRevocationValue(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export async function loadSharedReport(token: string) {
  return (await resolveSharedReport(token)).report
}

export async function loadSharedReportEvidence(token: string, artifactId: string) {
  const shared = await resolveSharedReport(token)
  if (!reportSafeScreenshotIds(shared.report).has(artifactId)) {
    throw new BusinessEvalsApiError(404, "SHARED_EVIDENCE_NOT_FOUND", "This report does not contain that report-safe image.")
  }
  const artifacts = await supabaseServiceJson<Row[]>(`evidence_artifacts?${query({
    select: "id,storage_path,mime_type,byte_size,expires_at",
    agency_id: `eq.${shared.agencyId}`,
    id: `eq.${artifactId}`,
    artifact_kind: "eq.screenshot",
    redacted: "eq.true",
    report_safe: "eq.true",
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1",
  })}`)
  const artifact = artifacts[0]
  if (!artifact) throw new BusinessEvalsApiError(410, "SHARED_EVIDENCE_EXPIRED", "This report image is no longer retained.")
  const storagePath = String(artifact.storage_path)
  if (!isEvalEvidencePathForWorkspace(storagePath, shared.agencyId)) {
    throw new BusinessEvalsApiError(403, "SHARED_EVIDENCE_DENIED", "The report image does not belong to this workspace.")
  }
  const response = await loadPrivateEvalArtifact(storagePath)
  const contentType = String(artifact.mime_type)
  if (!new Set(["image/png", "image/jpeg"]).has(contentType)) {
    throw new BusinessEvalsApiError(415, "SHARED_EVIDENCE_TYPE_BLOCKED", "Only redacted report images can be shared.")
  }
  return { body: response.body, contentType, byteSize: Number(artifact.byte_size ?? 0) }
}

async function resolveSharedReport(token: string) {
  if (!isReportShareToken(token)) {
    throw new BusinessEvalsApiError(404, "SHARE_LINK_NOT_FOUND", "This report link is invalid, expired or revoked.")
  }
  const tokenHash = hashReportShareToken(token, getSharePepper())
  const links = await supabaseServiceJson<Row[]>("rpc/consume_report_share_link", {
    method: "POST",
    body: JSON.stringify({ p_token_hash: tokenHash }),
  })
  const link = links[0]
  if (!link) throw new BusinessEvalsApiError(404, "SHARE_LINK_NOT_FOUND", "This report link is invalid, expired or revoked.")
  const reports = await supabaseServiceJson<Row[]>(`reports?${query({
    select: "id,client_id,period_start,period_end,status,narrative,metrics_json,snapshot_version,snapshot_json,evidence_fingerprint,eval_evidence_fingerprint,eval_snapshot_idempotency_key,stale_at,created_at",
    agency_id: `eq.${String(link.agency_id)}`,
    id: `eq.${String(link.report_id)}`,
    snapshot_version: `eq.${Number(link.snapshot_version)}`,
    evidence_fingerprint: `eq.${String(link.evidence_fingerprint)}`,
    limit: "1",
  })}`)
  const report = reports[0]
  if (!report || report.status !== "ready" || report.stale_at) {
    throw new BusinessEvalsApiError(410, "REPORT_CHANGED", "This report snapshot is no longer current.")
  }
  assertServiceIssuedEvalSnapshot(report)
  if (hashReportSnapshot(report.snapshot_json ?? {}) !== String(link.snapshot_hash ?? "")) {
    throw new BusinessEvalsApiError(410, "REPORT_SNAPSHOT_CHANGED", "The shared report snapshot no longer matches its immutable link binding.")
  }
  const entitlement = await getBusinessEvalsEntitlement(String(link.agency_id))
  const [agencies, projects] = await Promise.all([
    entitlement.features.whiteLabel ? supabaseServiceJson<Row[]>(`agencies?${query({
      select: "name",
      id: `eq.${String(link.agency_id)}`,
      limit: "1",
    })}`) : Promise.resolve([]),
    supabaseServiceJson<Row[]>(`clients?${query({
      select: "name",
      agency_id: `eq.${String(link.agency_id)}`,
      id: `eq.${String(report.client_id)}`,
      limit: "1",
    })}`),
  ])
  const brandName = entitlement.features.whiteLabel
    ? String(agencies[0]?.name ?? "Business Evals")
    : "Maintain Flow"
  const safeContent = buildReportSafeContent({
    snapshot: report.snapshot_json,
    source: "business_eval",
    snapshotVersion: Number(report.snapshot_version),
    evidenceFingerprint: String(report.eval_evidence_fingerprint ?? report.evidence_fingerprint ?? ""),
    fallbackSummary: report.narrative,
    fallbackMetrics: report.metrics_json,
    generatedAt: report.created_at,
  })
  const publicReport = {
    id: String(report.id),
    projectName: String(projects[0]?.name ?? "Project"),
    periodStart: String(report.period_start),
    periodEnd: String(report.period_end),
    snapshotVersion: Number(report.snapshot_version),
    expiresAt: String(link.expires_at),
    brandName,
    source: "business_eval" as const,
    evidenceModel: "Business eval" as const,
    stageEvidenceAvailable: true,
    coverageDisclosure: "Business-eval journey evidence only. Legacy endpoint checks are not represented as browser-stage evidence in this snapshot.",
    ...safeContent,
    evidenceFingerprint: safeContent.provenance.evidenceFingerprint,
  }
  return { agencyId: String(link.agency_id), report: publicReport }
}

function assertServiceIssuedEvalSnapshot(report: Row) {
  const snapshot = isRecord(report.snapshot_json) ? report.snapshot_json : null
  const fingerprint = String(report.evidence_fingerprint ?? "")
  const evalFingerprint = String(report.eval_evidence_fingerprint ?? "")
  const embeddedFingerprint = String(snapshot?.evidenceFingerprint ?? "")
  const idempotencyKey = String(report.eval_snapshot_idempotency_key ?? "").trim()
  if (
    !idempotencyKey
    || !/^[a-f0-9]{64}$/.test(fingerprint)
    || evalFingerprint !== fingerprint
    || embeddedFingerprint !== fingerprint
  ) {
    throw new BusinessEvalsApiError(409, "EVAL_REPORT_PROVENANCE_INVALID", "Only service-issued Business Evals snapshots can be shared.")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function assertPaidReportingEntitlement(agencyId: string) {
  const entitlement = await getBusinessEvalsEntitlement(agencyId)
  if (!entitlement.features.liveLink) {
    throw new BusinessEvalsApiError(402, "PAID_REPORTING_REQUIRED", "Live report links are available on Solo, Team and Agency plans.")
  }
}

function getSharePepper() {
  const value = process.env.REPORT_SHARE_TOKEN_PEPPER?.trim() ?? ""
  if (value.length < 32) throw new BusinessEvalsApiError(503, "SHARE_LINKS_NOT_CONFIGURED", "Report share links are not configured.")
  return value
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
