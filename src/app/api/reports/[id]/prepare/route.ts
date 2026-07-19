import { bearerToken } from "@/lib/supabase/report-download.server"
import { businessEvalsErrorResponse, requireBusinessEvalsAuth } from "@/lib/api/business-evals-auth.server"
import {
  isBusinessEvalReport,
  prepareBusinessEvalReportPdf,
} from "@/lib/reports/business-evals-report-pdf-storage.server"
import {
  getReportPdfStorageConfig,
  prepareAndStoreAuthorizedReportPdf,
  ReportPdfStorageError,
} from "@/lib/supabase/report-pdf-storage.server"
import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(
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
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }

  const config = getReportPdfStorageConfig()
  if (!config.enabled) {
    return NextResponse.json({ message: "Report storage is not configured." }, { status: 503 })
  }

  try {
    const auth = await requireBusinessEvalsAuth(request)
    if (await isBusinessEvalReport(auth.workspace.id, id)) {
      return NextResponse.json(await prepareBusinessEvalReportPdf(auth.workspace.id, id))
    }
    return NextResponse.json(await prepareAndStoreAuthorizedReportPdf(config, token, id))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      return businessEvalsErrorResponse(error)
    }
    const status = error instanceof ReportPdfStorageError ? error.status : 500
    const message = error instanceof Error ? error.message : "Report PDF preparation failed."
    return NextResponse.json({ message }, { status })
  }
}
