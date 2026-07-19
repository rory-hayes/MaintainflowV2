import { Document, Font, Page, StyleSheet, Text, View, pdf } from "@react-pdf/renderer"
import type { Readable } from "node:stream"
import React from "react"

export type BusinessEvalReportPdfModel = {
  brandName: string
  projectName: string
  periodStart: string
  periodEnd: string
  generatedAt: string
  snapshotVersion: number
  evidenceFingerprint: string
  metrics: {
    journeysCovered: number
    evalRuns: number
    passedRuns: number
    passRate: number
    incidents: number
    recoveries: number
  }
  journeys: Array<{ name: string; template: string; runCount: number; latestVerdict: string }>
  runs: Array<{ verdict: string; summary: string; businessImpact: string; cleanupStatus: string; completedAt: string }>
  incidents: Array<{ title: string; severity: string; status: string; reportSafeSummary: string }>
}

const colors = {
  ink: "#16181d",
  muted: "#667085",
  line: "#dfe3ea",
  page: "#f7f8fa",
  white: "#ffffff",
  blue: "#1769e0",
  blueSoft: "#eef5ff",
  green: "#067647",
  red: "#b42318",
  amber: "#b54708",
}

Font.registerHyphenationCallback((word) => [word])

const styles = StyleSheet.create({
  page: { padding: 38, paddingBottom: 58, fontFamily: "Helvetica", color: colors.ink, backgroundColor: colors.page },
  hero: { padding: 24, marginBottom: 18, borderRadius: 12, backgroundColor: colors.ink, color: colors.white },
  brand: { fontSize: 9, textTransform: "uppercase", letterSpacing: 1.5, color: "#bfd4fb", marginBottom: 24 },
  title: { fontSize: 26, fontWeight: 700, lineHeight: 1.15, marginBottom: 8 },
  subtitle: { fontSize: 10, color: "#d4dded", lineHeight: 1.45 },
  metaRow: { display: "flex", flexDirection: "row", marginTop: 20 },
  meta: { width: "33.33%", paddingRight: 10 },
  metaLabel: { fontSize: 7, textTransform: "uppercase", color: "#9fbef4", marginBottom: 4 },
  metaValue: { fontSize: 10, fontWeight: 700, color: colors.white },
  section: { marginTop: 11 },
  sectionTitle: { fontSize: 13, fontWeight: 700, marginBottom: 8 },
  metrics: { display: "flex", flexDirection: "row", flexWrap: "wrap", marginRight: -8 },
  metric: { width: "31.8%", padding: 11, marginRight: 8, marginBottom: 8, border: `1 solid ${colors.line}`, borderRadius: 9, backgroundColor: colors.white },
  metricLabel: { fontSize: 7, color: colors.muted, textTransform: "uppercase", marginBottom: 7 },
  metricValue: { fontSize: 18, fontWeight: 700 },
  card: { padding: 12, marginBottom: 7, border: `1 solid ${colors.line}`, borderRadius: 9, backgroundColor: colors.white },
  row: { display: "flex", flexDirection: "row", justifyContent: "space-between" },
  rowTitle: { fontSize: 9.5, fontWeight: 700, maxWidth: "75%" },
  badge: { fontSize: 7, fontWeight: 700, textTransform: "uppercase" },
  body: { fontSize: 8.5, lineHeight: 1.5, color: "#344054", marginTop: 6 },
  small: { fontSize: 7.5, lineHeight: 1.4, color: colors.muted, marginTop: 4 },
  table: { border: `1 solid ${colors.line}`, borderRadius: 9, overflow: "hidden", backgroundColor: colors.white },
  tableHeader: { display: "flex", flexDirection: "row", padding: 8, backgroundColor: colors.blueSoft, borderBottom: `1 solid ${colors.line}` },
  tableRow: { display: "flex", flexDirection: "row", padding: 8, borderBottom: `1 solid ${colors.line}` },
  cellWide: { width: "44%", fontSize: 8 },
  cell: { width: "18.66%", fontSize: 8 },
  headerCell: { color: "#174a91", fontWeight: 700, textTransform: "uppercase", fontSize: 7 },
  footer: { position: "absolute", left: 38, right: 38, bottom: 26, display: "flex", flexDirection: "row", justifyContent: "space-between", borderTop: `1 solid ${colors.line}`, paddingTop: 8 },
  footerText: { fontSize: 7, color: colors.muted },
})

export async function renderBusinessEvalReportPdf(model: BusinessEvalReportPdfModel) {
  const output = await pdf(createDocument(model)).toBuffer()
  return streamToBuffer(output as unknown as Readable)
}

function createDocument(model: BusinessEvalReportPdfModel) {
  const metricEntries: Array<[string, string]> = [
    ["Journeys covered", String(model.metrics.journeysCovered)],
    ["Eval runs", String(model.metrics.evalRuns)],
    ["Pass rate", `${formatNumber(model.metrics.passRate)}%`],
    ["Passed runs", String(model.metrics.passedRuns)],
    ["Incidents", String(model.metrics.incidents)],
    ["Verified recoveries", String(model.metrics.recoveries)],
  ]

  return React.createElement(
    Document,
    { title: `${model.projectName} Business Evals Report`, author: model.brandName, subject: "Deterministic customer-journey evidence" },
    React.createElement(
      Page,
      { size: "A4", style: styles.page },
      React.createElement(
        View,
        { style: styles.hero, wrap: false },
        React.createElement(Text, { style: styles.brand }, model.brandName),
        React.createElement(Text, { style: styles.title }, `${model.projectName} Business Evals Report`),
        React.createElement(Text, { style: styles.subtitle }, "Deterministic proof that critical customer journeys reached their configured business outcomes."),
        React.createElement(
          View,
          { style: styles.metaRow },
          meta("Period", `${formatDate(model.periodStart)} - ${formatDate(model.periodEnd)}`),
          meta("Generated", formatDate(model.generatedAt)),
          meta("Snapshot", `Version ${model.snapshotVersion}`)
        )
      ),
      section(
        "Outcome summary",
        React.createElement(
          View,
          { style: styles.metrics, wrap: false },
          ...metricEntries.map(([label, value]) =>
            React.createElement(
              View,
              { key: label, style: styles.metric },
              React.createElement(Text, { style: styles.metricLabel }, label),
              React.createElement(Text, { style: styles.metricValue }, value)
            )
          )
        )
      ),
      section("Journey coverage", journeyTable(model.journeys)),
      section(
        "Recent eval outcomes",
        ...model.runs.slice(-8).reverse().map((run, index) =>
          React.createElement(
            View,
            { key: `${run.completedAt}-${index}`, style: styles.card, wrap: false },
            React.createElement(
              View,
              { style: styles.row },
              React.createElement(Text, { style: styles.rowTitle }, run.summary || "Configured journey evaluation"),
              React.createElement(Text, { style: [styles.badge, { color: verdictColor(run.verdict) }] }, run.verdict)
            ),
            run.businessImpact ? React.createElement(Text, { style: styles.body }, run.businessImpact) : null,
            React.createElement(Text, { style: styles.small }, `${formatDateTime(run.completedAt)} · cleanup ${run.cleanupStatus}`)
          )
        )
      ),
      section(
        "Incidents and verified recovery",
        ...(model.incidents.length
          ? model.incidents.map((incident, index) =>
              React.createElement(
                View,
                { key: `${incident.title}-${index}`, style: styles.card, wrap: false },
                React.createElement(
                  View,
                  { style: styles.row },
                  React.createElement(Text, { style: styles.rowTitle }, incident.title),
                  React.createElement(Text, { style: [styles.badge, { color: incident.status === "resolved" ? colors.green : colors.red }] }, incident.status)
                ),
                React.createElement(Text, { style: styles.body }, incident.reportSafeSummary || "No additional report-safe detail was recorded."),
                React.createElement(Text, { style: styles.small }, `Severity: ${incident.severity}`)
              )
            )
          : [React.createElement(View, { key: "none", style: styles.card }, React.createElement(Text, { style: styles.body }, "No reportable incidents were recorded in this period."))])
      ),
      React.createElement(
        View,
        { style: styles.footer, fixed: true },
        React.createElement(Text, { style: styles.footerText }, `Evidence ${model.evidenceFingerprint.slice(0, 16)}…`),
        React.createElement(Text, { style: styles.footerText, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` })
      )
    )
  )
}

function journeyTable(journeys: BusinessEvalReportPdfModel["journeys"]) {
  return React.createElement(
    View,
    { style: styles.table },
    React.createElement(
      View,
      { style: styles.tableHeader },
      React.createElement(Text, { style: [styles.cellWide, styles.headerCell] }, "Journey"),
      React.createElement(Text, { style: [styles.cell, styles.headerCell] }, "Template"),
      React.createElement(Text, { style: [styles.cell, styles.headerCell] }, "Runs"),
      React.createElement(Text, { style: [styles.cell, styles.headerCell] }, "Latest")
    ),
    ...journeys.map((journey, index) =>
      React.createElement(
        View,
        { key: `${journey.name}-${index}`, style: styles.tableRow, wrap: false },
        React.createElement(Text, { style: styles.cellWide }, journey.name),
        React.createElement(Text, { style: styles.cell }, templateLabel(journey.template)),
        React.createElement(Text, { style: styles.cell }, String(journey.runCount)),
        React.createElement(Text, { style: [styles.cell, { color: verdictColor(journey.latestVerdict), fontWeight: 700 }] }, journey.latestVerdict)
      )
    )
  )
}

function section(title: string, ...children: React.ReactNode[]) {
  return React.createElement(
    View,
    { style: styles.section },
    React.createElement(Text, { style: styles.sectionTitle }, title),
    ...children
  )
}

function meta(label: string, value: string) {
  return React.createElement(
    View,
    { style: styles.meta },
    React.createElement(Text, { style: styles.metaLabel }, label),
    React.createElement(Text, { style: styles.metaValue }, value)
  )
}

function verdictColor(verdict: string) {
  if (verdict === "passed") return colors.green
  if (verdict === "degraded") return colors.amber
  if (verdict === "failed") return colors.red
  return colors.muted
}

function templateLabel(template: string) {
  if (template === "lead_form") return "Lead form"
  if (template === "trial_signup") return "Trial signup"
  return "Legacy endpoint"
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeZone: "UTC" }).format(date)
}

function formatDateTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)
}

async function streamToBuffer(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}
