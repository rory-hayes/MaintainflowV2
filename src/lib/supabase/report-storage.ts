"use client"

import { getValidSupabaseAccessToken } from "./auth"

export async function prepareReportPdfFromApi(reportId: string) {
  const token = await getValidSupabaseAccessToken()
  if (!token) {
    throw new Error("Sign in before preparing this report.")
  }

  const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/prepare`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  const payload = await response.json().catch(() => null) as { pdfStoragePath?: string; status?: string; updatedAt?: string; message?: string } | null

  if (!response.ok) {
    throw new Error(payload?.message || "Could not prepare the private report PDF.")
  }

  return {
    pdfStoragePath: payload?.pdfStoragePath ?? "",
    status: payload?.status ?? "",
    updatedAt: payload?.updatedAt ?? "",
  }
}

export async function downloadReportPdfFromApi(reportId: string, filename: string) {
  const token = await getValidSupabaseAccessToken()
  if (!token) {
    throw new Error("Sign in before downloading this report.")
  }

  const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/download`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const message = await response.text().catch(() => "")
    throw new Error(message || "Could not download the report PDF.")
  }

  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
