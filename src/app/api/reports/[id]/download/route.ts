import { bearerToken, getReportDownloadConfig, loadAuthorizedReportPdf } from "@/lib/supabase/report-download.server"
import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import {
  isBusinessEvalReport,
  loadBusinessEvalReportPdf,
} from "@/lib/reports/business-evals-report-pdf-storage.server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string }>
  }
) {
  const { id } = await params
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    return new NextResponse("Unauthorized", { status: 401 })
  }

  const config = getReportDownloadConfig()
  if (!config.enabled) {
    return new NextResponse("Report storage is not configured.", { status: 503 })
  }

  try {
    const auth = await requireBusinessEvalsAuth(request)
    if (await isBusinessEvalReport(auth.workspace.id, id)) {
      const reportPdf = await loadBusinessEvalReportPdf(auth.workspace.id, id)
      return new NextResponse(reportPdf.body, {
        status: 200,
        headers: {
          "Content-Type": reportPdf.contentType,
          "Content-Disposition": `attachment; filename="${reportPdf.filename}"`,
          "Cache-Control": "private, no-store",
        },
      })
    }
    const reportPdf = await loadAuthorizedReportPdf(config, token, id)

    return new NextResponse(reportPdf.body, {
      status: reportPdf.status,
      headers: {
        ...(reportPdf.contentType ? { "Content-Type": reportPdf.contentType } : {}),
        ...(reportPdf.filename ? { "Content-Disposition": `attachment; filename="${reportPdf.filename}"` } : {}),
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return businessEvalsErrorResponse(error)
    }
    return new NextResponse(error instanceof Error ? error.message : "Report download failed.", { status: 500 })
  }
}
