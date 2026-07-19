import "server-only"

import { createHash } from "node:crypto"

import { getSupabaseServerConfig } from "@/lib/supabase/server"
import type { RunnerArtifact } from "@/lib/runner/types"

export const EVAL_EVIDENCE_BUCKET = "maintainflow-eval-evidence"

export type StoredEvidenceArtifact = {
  storagePath: string
  sha256: string
  byteSize: number
  contentType: string
  kind: RunnerArtifact["kind"]
  reportSafe: boolean
  redacted: boolean
}

export async function storePrivateEvalArtifact(input: {
  agencyId: string
  projectId: string
  journeyId: string
  runId: string
  artifact: RunnerArtifact
  artifactId?: string
}) {
  const config = getSupabaseServerConfig()
  const bytes = Buffer.from(input.artifact.dataBase64, "base64")
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
    throw new Error("Eval evidence must be between 1 byte and 25 MB.")
  }

  const artifactId = input.artifactId ?? crypto.randomUUID()
  const extension = extensionForContentType(input.artifact.contentType)
  const storagePath = [
    safeSegment(input.agencyId),
    "projects",
    safeSegment(input.projectId),
    "journeys",
    safeSegment(input.journeyId),
    "runs",
    safeSegment(input.runId),
    "stages",
    safeSegment(input.artifact.stageId),
    `${safeSegment(artifactId)}.${extension}`,
  ].join("/")

  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/${EVAL_EVIDENCE_BUCKET}/${encodeStoragePath(storagePath)}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": input.artifact.contentType,
        "Cache-Control": "private, max-age=0, must-revalidate",
        "x-upsert": "false",
      },
      body: bytes,
    }
  )
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(detail || "Private eval evidence could not be stored.")
  }

  return {
    storagePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    contentType: input.artifact.contentType,
    kind: input.artifact.kind,
    reportSafe: input.artifact.reportSafe,
    redacted: input.artifact.redacted,
  } satisfies StoredEvidenceArtifact
}

export async function createEvalEvidenceSignedUrl(storagePath: string, expiresInSeconds = 300) {
  const config = getSupabaseServerConfig()
  const boundedExpiry = Math.max(30, Math.min(expiresInSeconds, 900))
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/sign/${EVAL_EVIDENCE_BUCKET}/${encodeStoragePath(storagePath)}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: boundedExpiry }),
    }
  )
  const payload = (await response.json().catch(() => ({}))) as { signedURL?: string; signedUrl?: string; message?: string }
  if (!response.ok) throw new Error(payload.message || "A short-lived evidence URL could not be created.")
  const path = payload.signedURL ?? payload.signedUrl
  if (!path) throw new Error("Supabase did not return a signed evidence URL.")
  return path.startsWith("http") ? path : `${config.supabaseUrl}/storage/v1${path}`
}

export async function deletePrivateEvalArtifact(storagePath: string) {
  if (!storagePath || storagePath.includes("..") || storagePath.startsWith("/")) {
    throw new Error("The evidence storage path is invalid.")
  }
  const config = getSupabaseServerConfig()
  const response = await fetch(`${config.supabaseUrl}/storage/v1/object/${EVAL_EVIDENCE_BUCKET}`, {
    method: "DELETE",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [storagePath] }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(detail || "Private eval evidence could not be removed.")
  }
}

export async function loadPrivateEvalArtifact(storagePath: string) {
  if (!storagePath || storagePath.includes("..") || storagePath.startsWith("/")) {
    throw new Error("The evidence storage path is invalid.")
  }
  const config = getSupabaseServerConfig()
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/${EVAL_EVIDENCE_BUCKET}/${encodeStoragePath(storagePath)}`,
    {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      cache: "no-store",
    }
  )
  if (!response.ok || !response.body) throw new Error("The private evidence artifact could not be loaded.")
  return response
}

export function isEvalEvidencePathForWorkspace(path: string, agencyId: string) {
  return path.startsWith(`${safeSegment(agencyId)}/projects/`) && !path.includes("..")
}

function safeSegment(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9-]{1,100}$/.test(normalized)) throw new Error("Evidence storage received an invalid path segment.")
  return normalized
}

function extensionForContentType(contentType: string) {
  if (contentType === "image/jpeg") return "jpg"
  if (contentType === "image/png") return "png"
  if (contentType === "application/zip") return "zip"
  if (contentType === "application/json") return "json"
  return "bin"
}

function encodeStoragePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/")
}
