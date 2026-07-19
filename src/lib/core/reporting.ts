import type { CheckRun, Client, Issue, Report, ReportItem, ReportMetrics, Workflow } from "./types.ts"
import { isTimestampInReportPeriod } from "./report-period.ts"
import { isServiceIssuedCheckRun } from "./evidence-provenance.ts"

export function aggregateReportMetrics({
  client,
  workflows,
  checkRuns,
  issues,
  periodStart,
  periodEnd,
}: {
  client: Client
  workflows: Workflow[]
  checkRuns: CheckRun[]
  issues: Issue[]
  periodStart: string
  periodEnd: string
}): ReportMetrics {
  const period = { periodStart, periodEnd }
  const includedWorkflowIds = new Set(
    workflows
      .filter((workflow) => workflow.clientId === client.id && workflow.reportIncluded && !workflow.archivedAt)
      .map((workflow) => workflow.id)
  )
  const runs = checkRuns.filter((run) => {
    if (!isServiceIssuedCheckRun(run)) return false
    return run.clientId === client.id
      && includedWorkflowIds.has(run.workflowId)
      && isTimestampInReportPeriod(run.createdAt, period)
  })
  const clientIssues = issues.filter((issue) => {
    return issue.reportable && issue.clientId === client.id && includedWorkflowIds.has(issue.workflowId) && isTimestampInReportPeriod(issue.createdAt, period)
  })
  const passedRuns = runs.filter((run) => run.status === "healthy").length
  const conclusiveRuns = runs.filter((run) => run.status !== "skipped").length
  const latencyValues = runs
    .map((run) => run.latencyMs)
    .filter((latency): latency is number => typeof latency === "number")

  return {
    workflowsMonitored: includedWorkflowIds.size,
    checksRun: runs.length,
    passRate: conclusiveRuns ? Math.round((passedRuns / conclusiveRuns) * 1000) / 10 : 0,
    issuesDetected: clientIssues.length,
    issuesResolved: clientIssues.filter((issue) => issue.status === "resolved").length,
    unresolvedHighRiskIssues: clientIssues.filter(
      (issue) => ["high", "critical"].includes(issue.severity) && !["resolved", "ignored", "snoozed"].includes(issue.status)
    ).length,
    averageLatencyMs: latencyValues.length
      ? Math.round(latencyValues.reduce((total, value) => total + value, 0) / latencyValues.length)
      : null,
  }
}

export function createReportNarrative(clientName: string, metrics: ReportMetrics) {
  const riskLine = metrics.unresolvedHighRiskIssues
    ? `${metrics.unresolvedHighRiskIssues} high-risk issue${metrics.unresolvedHighRiskIssues === 1 ? "" : "s"} still need review before this report is sent.`
    : "No unresolved high-risk issues remain for the period."
  const detectedIssueLabel = `${metrics.issuesDetected} issue${metrics.issuesDetected === 1 ? "" : "s"}`
  const detectedIssueVerb = metrics.issuesDetected === 1 ? "was" : "were"
  const resolvedIssueVerb = metrics.issuesResolved === 1 ? "was" : "were"

  return `This period, Maintain Flow monitored ${metrics.workflowsMonitored} workflow${metrics.workflowsMonitored === 1 ? "" : "s"} for ${clientName} and recorded ${metrics.checksRun} check run${metrics.checksRun === 1 ? "" : "s"}. The pass rate was ${metrics.passRate}%. ${detectedIssueLabel} ${detectedIssueVerb} detected and ${metrics.issuesResolved} ${resolvedIssueVerb} resolved with report-safe notes. ${riskLine}`
}

export function reportGenerationEvidenceError(metrics: Pick<Report["metrics"], "workflowsMonitored" | "checksRun">) {
  if (metrics.workflowsMonitored === 0) {
    return "Add at least one active, report-included workflow for this client before generating a report."
  }

  if (metrics.checksRun === 0) {
    return "Run at least one report-included workflow check in the selected period before generating a report."
  }

  return ""
}

export function createReportDownloadData(report: Report, client: Client, agencyName: string, reportItems: ReportItem[] = []) {
  const document = createPdfDocument()
  drawCoverHeader(document, report, client, agencyName)
  drawMetaStrip(document, report, client, agencyName)
  drawMetricGrid(document, report)
  drawNarrativeSection(document, report)
  drawReadinessSection(document, report)
  drawEvidenceSection(document, reportItems)

  return `data:application/pdf;base64,${base64Pdf(document)}`
}

type PdfColor = [number, number, number]

type PdfPage = {
  commands: string[]
  y: number
}

type PdfDocument = {
  pages: PdfPage[]
  width: number
  height: number
  margin: number
}

const colors = {
  white: [1, 1, 1] as PdfColor,
  ink: [0.06, 0.07, 0.09] as PdfColor,
  muted: [0.38, 0.4, 0.45] as PdfColor,
  line: [0.85, 0.87, 0.91] as PdfColor,
  soft: [0.96, 0.97, 0.99] as PdfColor,
  blue: [0, 0.4, 0.99] as PdfColor,
  blueSoft: [0.9, 0.94, 1] as PdfColor,
  success: [0.03, 0.45, 0.24] as PdfColor,
  warning: [0.74, 0.36, 0.05] as PdfColor,
}

function createPdfDocument(): PdfDocument {
  const document = { pages: [], width: 612, height: 792, margin: 48 }
  addPage(document, true)
  return document
}

function currentPage(document: PdfDocument) {
  return document.pages[document.pages.length - 1]
}

function addPage(document: PdfDocument, cover = false) {
  const page: PdfPage = { commands: [], y: cover ? 620 : 708 }
  document.pages.push(page)

  if (!cover) {
    drawText(page, "Maintain Flow Client Report", document.margin, 748, 13, "F2", colors.ink)
    drawLine(page, document.margin, 732, document.width - document.margin, 732, colors.line)
  }

  return page
}

function ensureSpace(document: PdfDocument, height: number) {
  if (currentPage(document).y - height < 78) {
    addPage(document)
  }
}

function drawCoverHeader(document: PdfDocument, report: Report, client: Client, agencyName: string) {
  const page = currentPage(document)
  drawRect(page, 0, 668, document.width, 124, colors.blue)
  drawText(page, "Maintain Flow", document.margin, 748, 13, "F2", colors.blueSoft)
  drawText(page, "Client Report", document.margin, 716, 30, "F2", colors.white)
  drawText(page, `${client.name} | ${report.periodStart} to ${report.periodEnd}`, document.margin, 692, 12, "F1", colors.blueSoft)
  drawText(page, agencyName, document.width - 214, 748, 11, "F2", colors.white)
}

function drawMetaStrip(document: PdfDocument, report: Report, client: Client, agencyName: string) {
  ensureSpace(document, 82)
  const page = currentPage(document)
  const y = page.y
  drawRoundedCard(page, document.margin, y - 72, document.width - document.margin * 2, 72, colors.soft)
  drawText(page, "Prepared for", document.margin + 18, y - 24, 8, "F2", colors.muted)
  drawText(page, client.name, document.margin + 18, y - 45, 15, "F2", colors.ink)
  drawText(page, "Prepared by", 248, y - 24, 8, "F2", colors.muted)
  drawText(page, agencyName, 248, y - 45, 12, "F2", colors.ink)
  drawText(page, "Report status", 430, y - 24, 8, "F2", colors.muted)
  drawText(page, titleCase(report.status), 430, y - 45, 12, "F2", report.status === "ready" || report.status === "sent" ? colors.success : colors.warning)
  page.y -= 96
}

function drawMetricGrid(document: PdfDocument, report: Report) {
  const metrics = [
    ["Monitored Workflows", String(report.metrics.workflowsMonitored)],
    ["Checks Run", String(report.metrics.checksRun)],
    ["Pass Rate", `${report.metrics.passRate}%`],
    ["Issues Detected", String(report.metrics.issuesDetected)],
    ["Issues Resolved", String(report.metrics.issuesResolved)],
    ["Open High-Risk", String(report.metrics.unresolvedHighRiskIssues)],
  ]

  drawSectionTitle(document, "Performance Snapshot")
  ensureSpace(document, 178)
  const page = currentPage(document)
  const gap = 12
  const width = (document.width - document.margin * 2 - gap * 2) / 3
  const height = 70

  metrics.forEach(([label, value], index) => {
    const row = Math.floor(index / 3)
    const column = index % 3
    const x = document.margin + column * (width + gap)
    const top = page.y - row * (height + gap)
    drawRoundedCard(page, x, top - height, width, height, colors.white)
    drawText(page, label, x + 14, top - 22, 8, "F2", colors.muted)
    drawText(page, value, x + 14, top - 52, 22, "F2", colors.ink)
  })

  page.y -= 164
}

function drawNarrativeSection(document: PdfDocument, report: Report) {
  drawSectionTitle(document, "Executive Summary")
  const lines = wrapText(report.narrative, 92)
  const height = Math.max(96, 38 + lines.length * 15)
  ensureSpace(document, height)
  const page = currentPage(document)
  const y = page.y
  drawRoundedCard(page, document.margin, y - height, document.width - document.margin * 2, height, colors.white)
  lines.forEach((line, index) => {
    drawText(page, line, document.margin + 18, y - 30 - index * 15, 10, "F1", colors.ink)
  })
  page.y -= height + 22
}

function drawReadinessSection(document: PdfDocument, report: Report) {
  const readinessRows = Object.entries(report.readiness).map(([key, value]) => [readinessLabel(key), value] as const)
  const height = Math.max(84, 30 + readinessRows.length * 18)
  ensureSpace(document, height + 56)
  drawSectionTitle(document, "Client Readiness")
  ensureSpace(document, height)
  const page = currentPage(document)
  const y = page.y
  drawRoundedCard(page, document.margin, y - height, document.width - document.margin * 2, height, colors.white)
  readinessRows.forEach(([label, value], index) => {
    const rowY = y - 28 - index * 18
    drawText(page, label, document.margin + 18, rowY, 9, "F1", colors.ink)
    drawText(page, value ? "Ready" : "Needs review", document.width - 144, rowY, 9, "F2", value ? colors.success : colors.warning)
  })
  page.y -= height + 22
}

function drawEvidenceSection(document: PdfDocument, reportItems: ReportItem[]) {
  const firstItemBodyLines = reportItems[0] ? wrapText(reportItems[0].body, 88).slice(0, 5) : []
  const firstItemHeight = reportItems[0] ? 58 + firstItemBodyLines.length * 14 : 74
  ensureSpace(document, firstItemHeight + 58)
  drawSectionTitle(document, "Evidence Log")

  if (!reportItems.length) {
    ensureSpace(document, 74)
    const page = currentPage(document)
    drawRoundedCard(page, 48, page.y - 64, 516, 64, colors.white)
    drawText(page, "No report-safe evidence was available for this period.", 66, page.y - 34, 10, "F1", colors.muted)
    page.y -= 86
    return
  }

  reportItems.forEach((item) => {
    const bodyLines = wrapText(item.body, 88).slice(0, 5)
    const height = 58 + bodyLines.length * 14
    ensureSpace(document, height + 12)
    const page = currentPage(document)
    const y = page.y
    drawRoundedCard(page, 48, y - height, 516, height, colors.white)
    drawText(page, item.title, 66, y - 24, 11, "F2", colors.ink)
    drawText(page, titleCase(item.sourceType.replace(/_/g, " ")), 454, y - 24, 8, "F2", colors.blue)
    bodyLines.forEach((line, index) => {
      drawText(page, line, 66, y - 48 - index * 14, 9, "F1", colors.muted)
    })
    page.y -= height + 14
  })
}

function drawSectionTitle(document: PdfDocument, title: string) {
  ensureSpace(document, 44)
  const page = currentPage(document)
  drawText(page, title, document.margin, page.y, 15, "F2", colors.ink)
  drawLine(page, document.margin, page.y - 11, document.width - document.margin, page.y - 11, colors.line)
  page.y -= 30
}

function drawRoundedCard(page: PdfPage, x: number, y: number, width: number, height: number, fill: PdfColor) {
  drawRect(page, x, y, width, height, fill)
  drawStrokeRect(page, x, y, width, height, colors.line)
}

function drawRect(page: PdfPage, x: number, y: number, width: number, height: number, fill: PdfColor) {
  page.commands.push(`q ${fillColor(fill)} ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(width)} ${formatNumber(height)} re f Q`)
}

function drawStrokeRect(page: PdfPage, x: number, y: number, width: number, height: number, stroke: PdfColor) {
  page.commands.push(`q ${strokeColor(stroke)} 0.8 w ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(width)} ${formatNumber(height)} re S Q`)
}

function drawLine(page: PdfPage, x1: number, y1: number, x2: number, y2: number, stroke: PdfColor) {
  page.commands.push(`q ${strokeColor(stroke)} 0.8 w ${formatNumber(x1)} ${formatNumber(y1)} m ${formatNumber(x2)} ${formatNumber(y2)} l S Q`)
}

function drawText(page: PdfPage, text: string, x: number, y: number, size: number, font: "F1" | "F2" | "F3", color: PdfColor) {
  page.commands.push(`BT /${font} ${formatNumber(size)} Tf ${fillColor(color)} ${formatNumber(x)} ${formatNumber(y)} Td (${escapePdf(text)}) Tj ET`)
}

function base64Pdf(document: PdfDocument) {
  addFooters(document)

  const pageObjects: Array<{ pageId: number; contentId: number; content: string }> = []
  let nextId = 6
  document.pages.forEach((page) => {
    pageObjects.push({ pageId: nextId, contentId: nextId + 1, content: page.commands.join("\n") })
    nextId += 2
  })

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    `2 0 obj << /Type /Pages /Kids [${pageObjects.map((page) => `${page.pageId} 0 R`).join(" ")}] /Count ${pageObjects.length} >> endobj`,
    "3 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >> endobj",
    ...pageObjects.flatMap((page) => [
      `${page.pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${document.width} ${document.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${page.contentId} 0 R >> endobj`,
      `${page.contentId} 0 obj << /Length ${page.content.length} >> stream\n${page.content}\nendstream endobj`,
    ]),
  ]
  let cursor = "%PDF-1.4\n".length
  const offsets = objects.map((object) => {
    const offset = cursor
    cursor += `${object}\n`.length
    return offset
  })
  const body = objects.join("\n") + "\n"
  const xrefStart = "%PDF-1.4\n".length + body.length
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefStart),
    "%%EOF",
  ].join("\n")
  const pdf = `%PDF-1.4\n${body}${xref}`

  if (typeof btoa === "function") {
    return btoa(pdf)
  }

  return Buffer.from(pdf, "binary").toString("base64")
}

function addFooters(document: PdfDocument) {
  document.pages.forEach((page, index) => {
    drawLine(page, document.margin, 52, document.width - document.margin, 52, colors.line)
    drawText(page, "Maintain Flow | Private client report", document.margin, 34, 8, "F1", colors.muted)
    drawText(page, `Page ${index + 1} of ${document.pages.length}`, document.width - 112, 34, 8, "F1", colors.muted)
  })
}

function wrapText(text: string, length: number) {
  const sanitized = sanitizePdfText(text)
  const paragraphs = sanitized.split(/\n+/)
  const lines: string[] = []

  paragraphs.forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean)
    let line = ""
    words.forEach((word) => {
      const nextLine = line ? `${line} ${word}` : word
      if (nextLine.length > length && line) {
        lines.push(line)
        line = word
      } else {
        line = nextLine
      }
    })
    if (line) {
      lines.push(line)
    }
  })

  return lines.length ? lines : [""]
}

function readinessLabel(key: string) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (value) => value.toUpperCase())
    .replace(/\bPdf\b/g, "PDF")
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function fillColor(color: PdfColor) {
  return `${color.map(formatNumber).join(" ")} rg`
}

function strokeColor(color: PdfColor) {
  return `${color.map(formatNumber).join(" ")} RG`
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

function sanitizePdfText(value: string) {
  return value.replace(/[^\x20-\x7E\n]/g, "")
}

function escapePdf(value: string) {
  return sanitizePdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}
