import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  pdf,
} from "@react-pdf/renderer"
import React from "react"
import type { Readable } from "node:stream"
import type { ReportViewModel } from "./report-view-model.ts"

const palette = {
  ink: "#101217",
  muted: "#626a76",
  faint: "#f5f7fb",
  line: "#dfe4ec",
  blue: "#0065fc",
  blueInk: "#073b88",
  blueSoft: "#eaf2ff",
  green: "#0f7a4f",
  greenSoft: "#e9f8f1",
  amber: "#a35d00",
  amberSoft: "#fff4de",
  red: "#b42318",
  redSoft: "#fff0ef",
  white: "#ffffff",
}

Font.registerHyphenationCallback((word) => [word])

const styles = StyleSheet.create({
  page: {
    padding: 36,
    paddingBottom: 54,
    fontFamily: "Helvetica",
    color: palette.ink,
    backgroundColor: palette.faint,
  },
  hero: {
    padding: 24,
    marginBottom: 18,
    backgroundColor: palette.ink,
    borderRadius: 12,
    color: palette.white,
  },
  brandRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 26,
  },
  brand: {
    fontSize: 11,
    color: "#dce7ff",
    textTransform: "uppercase",
    letterSpacing: 1.4,
  },
  confidential: {
    fontSize: 9,
    color: "#dce7ff",
  },
  title: {
    fontSize: 27,
    lineHeight: 1.16,
    fontWeight: 700,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 1.45,
    color: "#dce7ff",
    marginBottom: 18,
  },
  heroGrid: {
    display: "flex",
    flexDirection: "row",
  },
  heroMeta: {
    width: "33.33%",
    paddingRight: 10,
  },
  heroMetaLabel: {
    fontSize: 8,
    color: "#9ebeff",
    marginBottom: 5,
    textTransform: "uppercase",
  },
  heroMetaValue: {
    fontSize: 12,
    fontWeight: 700,
    color: palette.white,
  },
  section: {
    marginTop: 12,
    marginBottom: 6,
  },
  sectionHeader: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 700,
  },
  sectionHint: {
    fontSize: 8,
    color: palette.muted,
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: palette.white,
    border: `1 solid ${palette.line}`,
    borderRadius: 10,
    padding: 13,
    marginBottom: 8,
  },
  paragraph: {
    fontSize: 10,
    lineHeight: 1.55,
    color: "#303641",
  },
  muted: {
    fontSize: 8.5,
    lineHeight: 1.4,
    color: palette.muted,
  },
  scoreGrid: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    marginRight: -8,
  },
  metric: {
    width: "31.8%",
    minHeight: 64,
    marginRight: 8,
    marginBottom: 8,
    backgroundColor: palette.white,
    border: `1 solid ${palette.line}`,
    borderRadius: 10,
    padding: 11,
  },
  metricLabel: {
    fontSize: 8,
    color: palette.muted,
    marginBottom: 8,
    textTransform: "uppercase",
  },
  metricValue: {
    fontSize: 19,
    fontWeight: 700,
  },
  row: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  rowTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: palette.ink,
  },
  rowMeta: {
    fontSize: 8.5,
    color: palette.muted,
    marginTop: 5,
  },
  badge: {
    minWidth: 54,
    paddingTop: 3,
    paddingBottom: 3,
    paddingHorizontal: 7,
    borderRadius: 999,
    fontSize: 7.5,
    fontWeight: 700,
    textAlign: "center",
    textTransform: "uppercase",
  },
  table: {
    backgroundColor: palette.white,
    border: `1 solid ${palette.line}`,
    borderRadius: 10,
    overflow: "hidden",
  },
  tableHeader: {
    display: "flex",
    flexDirection: "row",
    backgroundColor: palette.blueSoft,
    borderBottom: `1 solid ${palette.line}`,
    paddingVertical: 7,
    paddingHorizontal: 9,
  },
  tableRow: {
    display: "flex",
    flexDirection: "row",
    borderBottom: `1 solid ${palette.line}`,
    paddingVertical: 8,
    paddingHorizontal: 9,
  },
  th: {
    fontSize: 7.5,
    color: palette.blueInk,
    fontWeight: 700,
    textTransform: "uppercase",
  },
  td: {
    fontSize: 8.5,
    color: "#2f3540",
    lineHeight: 1.35,
  },
  footer: {
    position: "absolute",
    bottom: 26,
    left: 36,
    right: 36,
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    borderTop: `1 solid ${palette.line}`,
    paddingTop: 8,
  },
  footerText: {
    fontSize: 7.5,
    color: palette.muted,
  },
})

export async function renderReportPdfBuffer(viewModel: ReportViewModel) {
  const output = await pdf(createReportPdfDocument(viewModel)).toBuffer()
  return streamToBuffer(output as unknown as Readable)
}

export async function renderReportPdfBase64(viewModel: ReportViewModel) {
  return (await renderReportPdfBuffer(viewModel)).toString("base64")
}

export async function renderReportPdfDataUrl(viewModel: ReportViewModel) {
  return `data:application/pdf;base64,${await renderReportPdfBase64(viewModel)}`
}

function createReportPdfDocument(viewModel: ReportViewModel) {
  return React.createElement(
    Document,
    { title: `${viewModel.client.name} Reliability Report`, author: viewModel.agency.name, subject: "Client journey reliability report" },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      React.createElement(Hero, { viewModel }),
      React.createElement(SummarySection, { viewModel }),
      React.createElement(ScorecardSection, { viewModel }),
      React.createElement(WorkflowCoverageSection, { viewModel }),
      React.createElement(CheckRunsSection, { viewModel }),
      React.createElement(IssuesSection, { title: "Agency-Reviewed Issues", issues: viewModel.issues, resolved: false }),
      React.createElement(IssuesSection, { title: "Resolved Issues and Repair Evidence", issues: viewModel.resolvedIssues, resolved: true }),
      React.createElement(RecommendationsSection, { viewModel }),
      React.createElement(EvidenceSection, { viewModel }),
      React.createElement(Footer, { viewModel })
    )
  )
}

function Hero({ viewModel }: { viewModel: ReportViewModel }) {
  return React.createElement(
    View,
    { style: styles.hero, wrap: false },
    React.createElement(
      View,
      { style: styles.brandRow },
      React.createElement(Text, { style: styles.brand }, "Maintain Flow"),
      React.createElement(Text, { style: styles.confidential }, "Private client reliability report")
    ),
    React.createElement(Text, { style: styles.title }, `${viewModel.client.name} Reliability Report`),
    React.createElement(
      Text,
      { style: styles.subtitle },
      "Business-journey coverage, outside-in evidence, agency-reviewed issues, repair evidence, and client-ready recommendations."
    ),
    React.createElement(
      View,
      { style: styles.heroGrid },
      React.createElement(HeroMeta, { label: "Period", value: viewModel.period.label }),
      React.createElement(HeroMeta, { label: "Prepared by", value: viewModel.agency.name }),
      React.createElement(HeroMeta, { label: "Generated", value: formatDateOnly(viewModel.generatedAt) })
    )
  )
}

function HeroMeta({ label, value }: { label: string; value: string }) {
  return React.createElement(
    View,
    { style: styles.heroMeta },
    React.createElement(Text, { style: styles.heroMetaLabel }, label),
    React.createElement(Text, { style: styles.heroMetaValue }, value || "n/a")
  )
}

function SummarySection({ viewModel }: { viewModel: ReportViewModel }) {
  const riskCopy = viewModel.scorecard.unresolvedHighRiskIssues
    ? `${viewModel.scorecard.unresolvedHighRiskIssues} unresolved high-risk item${viewModel.scorecard.unresolvedHighRiskIssues === 1 ? "" : "s"} should be reviewed before sending this report.`
    : "No unresolved high-risk reportable issues remain for this period."

  return React.createElement(
    ReportSection,
    { title: "Executive Summary", hint: "Client-ready narrative" },
    React.createElement(
      View,
      { style: styles.card },
      React.createElement(Text, { style: styles.paragraph }, viewModel.reportSafeNarrative),
      React.createElement(Text, { style: { ...styles.rowMeta, marginTop: 10 } }, riskCopy)
    )
  )
}

function ReportSection({ title, hint, children, keepTogether }: { title: string; hint?: string; children?: React.ReactNode; keepTogether?: boolean }) {
  return React.createElement(
    View,
    { style: styles.section, wrap: keepTogether ? false : undefined },
    React.createElement(
      View,
      { style: styles.sectionHeader },
      React.createElement(Text, { style: styles.sectionTitle }, title),
      hint ? React.createElement(Text, { style: styles.sectionHint }, hint) : null
    ),
    children
  )
}

function ScorecardSection({ viewModel }: { viewModel: ReportViewModel }) {
  const metrics = [
    ["Workflows included", viewModel.scorecard.workflowsMonitored],
    ["Checks run", viewModel.scorecard.checksRun],
    ["Pass rate", `${viewModel.scorecard.passRate}%`],
    ["Issues detected", viewModel.scorecard.issuesDetected],
    ["Issues resolved", viewModel.scorecard.issuesResolved],
    ["Average latency", viewModel.scorecard.averageLatencyMs === null ? "n/a" : `${viewModel.scorecard.averageLatencyMs}ms`],
  ]

  return React.createElement(
    ReportSection,
    { title: "Reliability Scorecard", hint: "Period snapshot" },
    React.createElement(
      View,
      { style: styles.scoreGrid, wrap: false },
      metrics.map(([label, value]) =>
        React.createElement(
          View,
          { key: String(label), style: styles.metric },
          React.createElement(Text, { style: styles.metricLabel }, String(label)),
          React.createElement(Text, { style: styles.metricValue }, String(value))
        )
      )
    )
  )
}

function WorkflowCoverageSection({ viewModel }: { viewModel: ReportViewModel }) {
  return React.createElement(
    ReportSection,
    { title: "Journey and Workflow Coverage", hint: `${viewModel.workflowCoverage.length} included` },
    viewModel.workflowCoverage.length
      ? viewModel.workflowCoverage.slice(0, 10).map((workflow) =>
          React.createElement(
            View,
            { key: workflow.workflowId, style: styles.card, wrap: false },
            React.createElement(
              View,
              { style: styles.row },
              React.createElement(Text, { style: styles.rowTitle }, workflow.name),
              React.createElement(StatusBadge, { status: workflow.status })
            ),
            React.createElement(Text, { style: styles.rowMeta }, `${workflow.method} ${workflow.endpointUrl}`),
            React.createElement(
              Text,
              { style: styles.rowMeta },
              `${workflow.checksRun} check run${workflow.checksRun === 1 ? "" : "s"} included | health score ${workflow.healthScore}`
            )
          )
        )
      : React.createElement(EmptyCard, { message: "No report-included journeys or workflows were available for this period." })
  )
}

function CheckRunsSection({ viewModel }: { viewModel: ReportViewModel }) {
  const shownRunCount = Math.min(viewModel.checkRuns.length, 12)
  const runHint = shownRunCount
    ? `${shownRunCount} of ${viewModel.scorecard.checksRun} period runs shown`
    : "No period runs"

  return React.createElement(
    ReportSection,
    { title: "Recent Assurance Evidence", hint: runHint },
    viewModel.checkRuns.length
      ? React.createElement(
          View,
          { style: styles.table },
          React.createElement(
            View,
            { style: styles.tableHeader },
            React.createElement(Text, { style: { ...styles.th, width: "35%" } }, "Workflow"),
            React.createElement(Text, { style: { ...styles.th, width: "18%" } }, "Status"),
            React.createElement(Text, { style: { ...styles.th, width: "18%" } }, "HTTP"),
            React.createElement(Text, { style: { ...styles.th, width: "29%" } }, "Evidence")
          ),
          viewModel.checkRuns.slice(0, 12).map((run, index) =>
            React.createElement(
              View,
              { key: run.checkRunId, style: { ...styles.tableRow, borderBottomWidth: index === Math.min(viewModel.checkRuns.length, 12) - 1 ? 0 : 1 }, wrap: false },
              React.createElement(Text, { style: { ...styles.td, width: "35%", fontWeight: 700 } }, run.workflowName),
              React.createElement(Text, { style: { ...styles.td, width: "18%" } }, titleCase(run.status === "skipped" ? "inconclusive" : run.status)),
              React.createElement(Text, { style: { ...styles.td, width: "18%" } }, `${run.statusCode ?? "n/a"} | ${run.latencyMs ?? "n/a"}ms`),
              React.createElement(Text, { style: { ...styles.td, width: "29%" } }, truncate(run.summary, 90))
            )
          )
        )
      : React.createElement(EmptyCard, { message: "No check runs were stored for this period." })
  )
}

function IssuesSection({ title, issues, resolved }: { title: string; issues: ReportViewModel["issues"]; resolved: boolean }) {
  return React.createElement(
    ReportSection,
    { title, hint: `${issues.length} ${resolved ? "resolved" : "open"}`, keepTogether: issues.length === 0 },
    issues.length
      ? issues.slice(0, 10).map((issue) =>
          React.createElement(
            View,
            { key: issue.issueId, style: styles.card, wrap: false },
            React.createElement(
              View,
              { style: styles.row },
              React.createElement(Text, { style: styles.rowTitle }, issue.title),
              React.createElement(StatusBadge, { status: resolved ? "resolved" : issue.severity })
            ),
            React.createElement(Text, { style: styles.rowMeta }, `${issue.workflowName} | ${titleCase(issue.severity)} | ${titleCase(issue.status)}`),
            React.createElement(Text, { style: { ...styles.muted, marginTop: 6 } }, issue.reportSafeSummary)
          )
        )
      : React.createElement(EmptyCard, { message: resolved ? "No resolved reportable issues for this period." : "No open reportable issues for this period." })
  )
}

function RecommendationsSection({ viewModel }: { viewModel: ReportViewModel }) {
  return React.createElement(
    ReportSection,
    { title: "Recommended Next Actions", hint: `${viewModel.recommendations.length} items` },
    viewModel.recommendations.length
      ? viewModel.recommendations.slice(0, 6).map((recommendation, index) =>
          React.createElement(
            View,
            { key: recommendation, style: styles.card, wrap: false },
            React.createElement(Text, { style: styles.rowTitle }, `Recommendation ${index + 1}`),
            React.createElement(Text, { style: { ...styles.muted, marginTop: 6 } }, recommendation)
          )
        )
      : React.createElement(EmptyCard, { message: "No report-safe recommendations were added for this period." })
  )
}

function EvidenceSection({ viewModel }: { viewModel: ReportViewModel }) {
  return React.createElement(
    ReportSection,
    { title: "Evidence Log", hint: `${viewModel.evidenceItems.length} report-safe items` },
    viewModel.evidenceItems.length
      ? viewModel.evidenceItems.slice(0, 14).map((item) =>
          React.createElement(
            View,
            { key: item.id, style: styles.card, wrap: false },
            React.createElement(
              View,
              { style: styles.row },
              React.createElement(Text, { style: styles.rowTitle }, item.title),
              React.createElement(Text, { style: { ...styles.muted, textTransform: "uppercase" } }, item.sourceType.replace(/_/g, " "))
            ),
            React.createElement(Text, { style: { ...styles.muted, marginTop: 6 } }, item.body)
          )
        )
      : React.createElement(EmptyCard, { message: "No report-safe evidence was available for this period." })
  )
}

function EmptyCard({ message }: { message: string }) {
  return React.createElement(
    View,
    { style: styles.card },
    React.createElement(Text, { style: styles.muted }, message)
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone = statusTone(status)
  return React.createElement(Text, { style: { ...styles.badge, ...tone } }, titleCase(status))
}

function Footer({ viewModel }: { viewModel: ReportViewModel }) {
  return React.createElement(
    View,
    { style: styles.footer, fixed: true },
    React.createElement(Text, { style: styles.footerText }, `${viewModel.agency.name} | Reliability Report by Maintain Flow`),
    React.createElement(Text, {
      style: styles.footerText,
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}`,
    })
  )
}

function statusTone(status: string) {
  const normalized = status.toLowerCase()
  if (["healthy", "resolved", "ready", "low"].includes(normalized)) {
    return { color: palette.green, backgroundColor: palette.greenSoft }
  }
  if (["degraded", "medium", "snoozed", "pending"].includes(normalized)) {
    return { color: palette.amber, backgroundColor: palette.amberSoft }
  }
  if (["failed", "critical", "high", "open"].includes(normalized)) {
    return { color: palette.red, backgroundColor: palette.redSoft }
  }
  return { color: palette.blueInk, backgroundColor: palette.blueSoft }
}

function titleCase(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function formatDateOnly(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value))
}

function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return `${value.slice(0, Math.max(0, length - 3)).trim()}...`
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
