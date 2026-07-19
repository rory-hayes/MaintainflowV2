"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"
import { IconArrowRight, IconCopy, IconDownload, IconExternalLink, IconFileAnalytics, IconFilePlus, IconLinkOff, IconShieldCheck } from "@tabler/icons-react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { z } from "zod"
import { businessEvalsRequest, createIdempotencyKey } from "@/lib/api/business-evals-client"
import {
  parseBusinessEvalsResponsePayload,
  reportResponseSchema,
  reportShareLinkResponseSchema,
  revokedReportShareLinkResponseSchema,
  sharedReportResponseSchema,
} from "@/lib/api/business-evals-response-schemas"
import type {
  ReportEvidenceSummary,
  ReportIncidentSummary,
  ReportJourneyCoverage,
  ReportProvenance,
} from "@/lib/reports/report-safe-contract"
import { clearPendingIdempotencyKey, pendingIdempotencyKey } from "../api-adapters"
import { useEvals } from "../evals-provider"
import { CollectionLoadMore, EvalBreadcrumbs, EvalPage, EmptyPanel, MetricCard, PageHeading } from "../page-primitives"
import type { EvalReport, EvalReportShare } from "../types"

export function ReportsPage() {
  const { reports, projectFor, projects, workspaceId, pagination } = useEvals()
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [message, setMessage] = useState("")
  const [periodStart, setPeriodStart] = useState(() => dateInputDaysAgo(29))
  const [periodEnd, setPeriodEnd] = useState(() => dateInputDaysAgo(0))

  async function createReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const projectId = String(form.get("projectId") ?? "")
    setCreating(true)
    setMessage("")
    try {
      const result = await businessEvalsRequest("/api/reports", reportResponseSchema, {
        workspaceId,
        method: "POST",
        idempotencyKey: createIdempotencyKey(`report-create:${projectId}:${periodStart}:${periodEnd}`),
        body: JSON.stringify({ projectId, periodStart, periodEnd }),
      })
      router.push(`/reports/${result.data.id}`)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The report snapshot could not be created.")
      setCreating(false)
    }
  }

  return (
    <EvalPage>
      <PageHeading title="Reports" description="Turn journey evidence, incidents and recovery into a client-ready business eval report." action={<Button type="button" onClick={() => setShowCreate((visible) => !visible)} className="rounded-md bg-blue-600 hover:bg-blue-700"><IconFilePlus data-icon="inline-start" />New report</Button>} />
      {showCreate ? <Card className="mb-6 rounded-lg border border-blue-200 bg-blue-50/40 shadow-none ring-0"><CardHeader><CardTitle>Create immutable report snapshot</CardTitle><CardDescription>Select a project and completed reporting period. Future dates and inverted ranges are rejected.</CardDescription></CardHeader><CardContent><form onSubmit={createReport} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_170px_170px_auto] md:items-end"><Field><FieldLabel htmlFor="report-project">Project</FieldLabel><NativeSelect id="report-project" name="projectId" required defaultValue={projects[0]?.id ?? ""}><NativeSelectOption value="">Choose project</NativeSelectOption>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.name}</NativeSelectOption>)}</NativeSelect></Field><Field><FieldLabel htmlFor="report-period-start">Period start</FieldLabel><Input id="report-period-start" type="date" value={periodStart} max={periodEnd} onChange={(event) => setPeriodStart(event.target.value)} required /></Field><Field><FieldLabel htmlFor="report-period-end">Period end</FieldLabel><Input id="report-period-end" type="date" value={periodEnd} min={periodStart} max={dateInputDaysAgo(0)} onChange={(event) => setPeriodEnd(event.target.value)} required /></Field><Button type="submit" disabled={creating || !projects.length} className="rounded-md bg-blue-600 hover:bg-blue-700">{creating ? "Creating…" : "Create snapshot"}</Button><FieldDescription className="md:col-span-4">Reports are generated from retained eval evidence; inconclusive stages do not count as proof.</FieldDescription></form><p role={message ? "alert" : undefined} className="mt-3 min-h-5 text-sm text-red-700">{message}</p></CardContent></Card> : null}
      <section className="mb-6 grid gap-3 sm:grid-cols-3">
        <MetricCard label="Reports" value={reports.length} detail="Across all projects" />
        <MetricCard label="Ready to share" value={reports.filter((report) => report.status === "ready").length} detail="Evidence complete" />
        <MetricCard label="Already shared" value={reports.filter((report) => report.status === "shared" || report.status === "sent").length} detail="Client-facing proof" />
      </section>
      <div className="flex flex-col gap-3">
        {reports.map((report) => {
          const project = projectFor(report.projectId)
          return <Card key={report.id} className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0"><Link href={`/reports/${report.id}`} className="grid gap-4 p-5 hover:bg-slate-50 md:grid-cols-[44px_minmax(0,1fr)_120px_130px_24px] md:items-center"><span className="flex size-10 items-center justify-center rounded-md bg-blue-50 text-blue-600"><IconFileAnalytics className="size-5" /></span><span><span className="block font-medium text-slate-950">{report.title}</span><span className="mt-1 block text-sm text-slate-500">{project?.name ?? report.projectName ?? "Historical project"} · {report.period}</span></span><span className="text-sm font-medium capitalize text-slate-700">{report.status}</span><span className="text-sm"><span className="block font-medium text-slate-900">{report.passRate}</span><span className="text-xs text-slate-500">pass rate</span></span><IconArrowRight className="size-4 text-slate-400" /></Link></Card>
        })}
        {!reports.length ? <EmptyPanel title="No reports yet" description="Create the first immutable snapshot after a project has completed eval runs." /> : null}
      </div>
      <CollectionLoadMore state={pagination.reports} label="reports" />
    </EvalPage>
  )
}

export function ReportDetailPage({ reportId }: { reportId: string }) {
  const { reports, projectFor, workspaceId } = useEvals()
  const queryClient = useQueryClient()
  const report = reports.find((item) => item.id === reportId)
  const project = report ? projectFor(report.projectId) : undefined
  const [message, setMessage] = useState("")
  const [shareUrl, setShareUrl] = useState("")
  const [shareLinks, setShareLinks] = useState<EvalReportShare[]>(report?.shares ?? [])
  const [pdfReady, setPdfReady] = useState(Boolean(report?.pdfReady))
  const [preparingPdf, setPreparingPdf] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [revokingId, setRevokingId] = useState("")
  if (!report || !project) return <EvalPage><EmptyPanel title="Report not found" description="This report does not exist in the current workspace." /></EvalPage>
  const reportIdForShare = report.id
  const reportSnapshotVersion = report.snapshotVersion ?? 0
  const reportReady = report.status === "ready" || report.status === "shared"
  const reportShareEligible = report.shareEligible !== false
  async function createShareLink() {
    setMessage("")
    try {
      if (!reportShareEligible) throw new Error("Historical legacy endpoint reports cannot be published as Business Evals live links.")
      const result = await businessEvalsRequest(`/api/reports/${encodeURIComponent(reportIdForShare)}/share-links`, reportShareLinkResponseSchema, {
        workspaceId,
        method: "POST",
        idempotencyKey: createIdempotencyKey(`report-share:${reportIdForShare}`),
        body: JSON.stringify({ expiresInHours: 168 }),
      })
      setShareUrl(result.data.url)
      setShareLinks((current) => [{
        id: result.data.id,
        snapshotVersion: result.data.snapshotVersion ?? reportSnapshotVersion,
        expiresAt: result.data.expiresAt,
        revokedAt: null,
        accessCount: 0,
        lastAccessedAt: null,
        createdAt: new Date().toISOString(),
      }, ...current.filter((link) => link.id !== result.data.id)])
      await navigator.clipboard.writeText(result.data.url).catch(() => undefined)
      setMessage("A seven-day share link was created and copied. This token is only shown now.")
      void queryClient.invalidateQueries({ queryKey: ["business-evals", workspaceId] })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The share link could not be created.")
    }
  }

  async function preparePdf() {
    setPreparingPdf(true)
    setMessage("")
    try {
      const token = await getValidSupabaseAccessToken()
      if (!token) throw new Error("Sign in before preparing a report PDF.")
      const response = await fetch(`/api/reports/${encodeURIComponent(reportIdForShare)}/prepare`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-MaintainFlow-Workspace-Id": workspaceId },
        cache: "no-store",
      })
      if (!response.ok) throw new Error(await responseErrorMessage(response, "The PDF could not be prepared."))
      setPdfReady(true)
      setMessage("The current immutable snapshot is ready to download as a PDF.")
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The PDF could not be prepared.")
    } finally {
      setPreparingPdf(false)
    }
  }

  async function downloadPdf() {
    setDownloadingPdf(true)
    setMessage("")
    try {
      const token = await getValidSupabaseAccessToken()
      if (!token) throw new Error("Sign in before downloading a report PDF.")
      const response = await fetch(`/api/reports/${encodeURIComponent(reportIdForShare)}/download`, {
        headers: { Authorization: `Bearer ${token}`, "X-MaintainFlow-Workspace-Id": workspaceId },
        cache: "no-store",
      })
      if (!response.ok) throw new Error(await responseErrorMessage(response, "The PDF could not be downloaded."))
      const blob = await response.blob()
      const filename = safeDownloadFilename(response.headers.get("Content-Disposition"), `business-eval-report-${reportIdForShare}.pdf`)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filename
      anchor.style.display = "none"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setMessage("PDF download started.")
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The PDF could not be downloaded.")
    } finally {
      setDownloadingPdf(false)
    }
  }

  async function revokeShareLink(linkId: string) {
    setRevokingId(linkId)
    setMessage("")
    const retryScope = `share-revoke:${workspaceId}:${reportIdForShare}:${linkId}`
    const idempotencyKey = pendingIdempotencyKey(retryScope)
    try {
      const result = await businessEvalsRequest(`/api/reports/${encodeURIComponent(reportIdForShare)}/share-links`, revokedReportShareLinkResponseSchema, {
        workspaceId,
        method: "DELETE",
        idempotencyKey,
        body: JSON.stringify({ linkId }),
      })
      clearPendingIdempotencyKey(retryScope, idempotencyKey)
      setShareLinks((current) => current.map((link) => link.id === linkId ? { ...link, revokedAt: result.data.revokedAt } : link))
      setMessage("The share link was revoked immediately.")
      void queryClient.invalidateQueries({ queryKey: ["business-evals", workspaceId] })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The share link could not be revoked.")
    } finally {
      setRevokingId("")
    }
  }
  return (
    <EvalPage>
      <EvalBreadcrumbs items={[{ label: "Reports", href: "/reports" }, { label: report.period }]} />
      <PageHeading title={report.title} description={`${project.name} · ${report.period}`} action={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={preparePdf} disabled={preparingPdf || Boolean(report.staleAt) || !reportReady} className="rounded-md border-slate-200"><IconFileAnalytics data-icon="inline-start" />{preparingPdf ? "Preparing…" : pdfReady ? "Prepare again" : "Prepare PDF"}</Button><Button variant="outline" onClick={downloadPdf} disabled={downloadingPdf || !pdfReady || Boolean(report.staleAt)} className="rounded-md border-slate-200"><IconDownload data-icon="inline-start" />{downloadingPdf ? "Downloading…" : "Download PDF"}</Button>{reportShareEligible ? <Button onClick={createShareLink} disabled={Boolean(report.staleAt) || !reportReady} className="rounded-md bg-blue-600 hover:bg-blue-700"><IconCopy data-icon="inline-start" />Create share link</Button> : null}</div>} />
      {!reportShareEligible ? <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">Historical legacy endpoint report. It preserves endpoint-monitor evidence and delivery state, but it is not eligible for a Business Evals public share link.</p> : null}
      {report.staleAt ? <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">This snapshot became stale on {formatApiDate(report.staleAt)}. Create a current report before preparing, downloading or sharing it.</p> : null}
      <ReportDocument report={report} projectName={project.name} />
      {shareUrl ? <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4"><p className="text-sm font-medium text-blue-950">Copy this link now</p><p className="mt-1 text-xs leading-5 text-blue-800">For security, Maintain Flow stores only the token hash and cannot reveal this URL again.</p><div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"><code className="min-w-0 flex-1 break-all rounded-md bg-white px-3 py-2 text-xs text-slate-800">{shareUrl}</code><Button nativeButton={false} render={<Link href={shareUrl} target="_blank" rel="noreferrer" />} className="shrink-0 rounded-md bg-blue-600 hover:bg-blue-700">Open link<IconExternalLink data-icon="inline-end" /></Button></div></div> : null}
      <Card className="mt-5 rounded-lg border border-slate-200 bg-white shadow-none ring-0"><CardHeader><CardTitle>Share-link ledger</CardTitle><CardDescription>Existing tokens cannot be recovered. Revoke active access here and create a replacement when needed.</CardDescription></CardHeader><CardContent>{shareLinks.length ? <div className="flex flex-col divide-y divide-slate-200">{shareLinks.map((link) => {
        const state = shareLinkState(link)
        return <div key={link.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_150px_auto] sm:items-center"><span className="min-w-0"><span className="block text-sm font-medium text-slate-900">Snapshot {link.snapshotVersion} · {state}</span><span className="mt-1 block break-all text-xs text-slate-500">ID {link.id}</span><span className="mt-1 block text-xs text-slate-500">Created {formatApiDate(link.createdAt)} · expires {formatApiDate(link.expiresAt)}</span></span><span className="text-xs text-slate-500">{link.accessCount} access{link.accessCount === 1 ? "" : "es"}<br />{link.lastAccessedAt ? `Last ${formatApiDate(link.lastAccessedAt)}` : "Never opened"}</span>{!link.revokedAt ? <Button type="button" variant="outline" size="sm" onClick={() => revokeShareLink(link.id)} disabled={revokingId === link.id} className="rounded-md border-slate-200"><IconLinkOff data-icon="inline-start" />{revokingId === link.id ? "Revoking…" : "Revoke"}</Button> : <span className="text-xs font-medium text-slate-500">Revoked {formatApiDate(link.revokedAt)}</span>}</div>
      })}</div> : <p className="text-sm text-slate-500">No share links have been created for this snapshot.</p>}</CardContent></Card>
      <p aria-live="polite" className="mt-3 text-sm text-slate-500">{message}</p>
    </EvalPage>
  )
}

type SharedReport = z.infer<typeof sharedReportResponseSchema>

export function PublicReportPage({ token }: { token: string }) {
  const [report, setReport] = useState<SharedReport | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    fetch(`/api/share/reports/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json().catch(() => null)
        const parsed = parseBusinessEvalsResponsePayload(payload, sharedReportResponseSchema)
        if (!response.ok || !parsed) throw new Error("This shared report returned an invalid response.")
        if (!parsed.ok) throw new Error(parsed.error.message)
        if (active) setReport(parsed.data)
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "This shared report is unavailable.") })
    return () => { active = false }
  }, [token])

  if (error) return <PublicReportState title="Report unavailable" description={error} />
  if (!report) return <PublicReportState title="Loading business eval report" description="Checking the shared evidence snapshot." />
  return (
    <main className="fixed inset-0 z-[100] overflow-y-auto bg-[#fbfaf7] px-5 py-8 md:px-8 md:py-12">
      <div className="mx-auto max-w-5xl">
      <div className="mb-8 flex items-center justify-between border-b border-slate-200 pb-5"><span className="flex items-center gap-2 text-lg font-semibold"><IconShieldCheck className="size-6 text-blue-600" />{report.brandName}</span><span className="text-xs text-slate-500">Read-only evidence report</span></div>
      <SharedReportDocument report={report} token={token} />
      </div>
    </main>
  )
}

function SharedReportDocument({ report, token }: { report: SharedReport; token: string }) {
  return (
    <article className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-200 px-6 py-8 md:px-10">
        <p className="text-xs font-medium uppercase tracking-[0.15em] text-blue-600">Business eval report</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{report.projectName}</h1>
        <p className="mt-2 text-sm text-slate-500">{formatReportPeriod(report.periodStart, report.periodEnd)} · snapshot {report.snapshotVersion} · expires {formatApiDate(report.expiresAt)}</p>
      </header>
      <div className="grid gap-8 px-6 py-8 md:grid-cols-[1fr_260px] md:px-10">
        <section>
          <h2 className="text-lg font-semibold text-slate-950">Executive summary</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">{report.summary || "Shared business eval evidence snapshot."}</p>
          <div className="mt-6 rounded-md border border-blue-200 bg-blue-50 p-3"><p className="text-xs font-medium uppercase tracking-wide text-blue-700">Evidence boundary</p><p className="mt-1 text-xs leading-5 text-blue-900">{report.coverageDisclosure}</p></div>
          <h2 className="mt-8 text-lg font-semibold text-slate-950">Evidence policy</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">This immutable view contains only allowlisted report-safe business evidence and redacted screenshots. Private traces, credentials, raw email content, diagnostic payloads and storage paths are excluded.</p>
        </section>
        <aside className="rounded-lg bg-slate-50 p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Snapshot metrics</p>
          <div className="mt-4 flex flex-col gap-3"><ReportMetric label="Journeys" value={report.metrics.journeysCovered} /><ReportMetric label="Eval runs" value={report.metrics.evalRuns} /><ReportMetric label="Passed runs" value={report.metrics.passedRuns} /><ReportMetric label="Pass rate" value={`${report.metrics.passRate}%`} /><ReportMetric label="Incidents" value={report.metrics.incidents} /><ReportMetric label="Verified recoveries" value={report.metrics.recoveries} /></div>
        </aside>
      </div>
      <ReportSafeSections
        journeys={report.coverage.journeys}
        incidents={report.incidents}
        recoveries={report.recoveries}
        evidenceSummaries={report.evidenceSummaries}
        provenance={report.provenance}
        publicEvidenceToken={token}
      />
      <footer className="border-t border-slate-200 px-6 py-4 text-xs text-slate-500 md:px-10">Read-only report · ID {report.id}</footer>
    </article>
  )
}

function ReportDocument({ report, projectName }: { report: EvalReport; projectName: string }) {
  const legacy = report.source === "legacy_endpoint"
  const coverageDisclosure = report.coverageDisclosure ?? (legacy
    ? "Historical deterministic endpoint-monitor evidence. This report does not contain browser-stage, email, screenshot, or cleanup proof."
    : "Business-eval journey evidence only. Legacy endpoint checks are not represented as browser-stage evidence in this snapshot.")
  return (
    <article className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-200 px-6 py-8 md:px-10"><p className="text-xs font-medium uppercase tracking-[0.15em] text-blue-600">{legacy ? "Legacy endpoint report" : "Business eval report"}</p><h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{projectName}</h2><p className="mt-2 text-sm text-slate-500">{report.period} · {legacy ? "Historical deterministic endpoint evidence" : "Evidence captured by Maintain Flow"}</p></header>
      <div className="grid gap-8 px-6 py-8 md:grid-cols-[1fr_260px] md:px-10">
        <section><h3 className="text-lg font-semibold text-slate-950">Executive summary</h3><p className="mt-3 text-sm leading-7 text-slate-600">{report.summary}</p><div className="mt-6 rounded-md border border-blue-200 bg-blue-50 p-3"><p className="text-xs font-medium uppercase tracking-wide text-blue-700">Evidence boundary</p><p className="mt-1 text-xs leading-5 text-blue-900">{coverageDisclosure}</p></div><h3 className="mt-8 text-lg font-semibold text-slate-950">What this proves</h3><p className="mt-3 text-sm leading-7 text-slate-600">{legacy ? "This historical report records deterministic endpoint availability and assertion evidence only. It does not claim browser journey, email, screenshot or cleanup proof." : "Maintain Flow evaluated the agreed public customer journeys during this period and retained evidence for each conclusive run. Inconclusive stages are not counted as proof."}</p></section>
        <aside className="rounded-lg bg-slate-50 p-5"><p className="text-xs text-slate-500">Outcome pass rate</p><p className="mt-1 text-3xl font-semibold text-slate-950">{report.passRate}</p><div className="mt-5 grid gap-4 text-sm"><ReportMetric label="Journeys covered" value={report.reportMetrics?.journeysCovered ?? report.journeysCovered} /><ReportMetric label="Eval runs" value={report.reportMetrics?.evalRuns ?? "—"} /><ReportMetric label="Incidents" value={report.reportMetrics?.incidents ?? "—"} /><ReportMetric label="Verified recoveries" value={report.reportMetrics?.recoveries ?? report.incidentsResolved} /><ReportMetric label="Report state" value={report.status} /></div></aside>
      </div>
      <ReportSafeSections journeys={report.journeyCoverage ?? []} incidents={report.reportIncidents ?? []} recoveries={report.verifiedRecoveries ?? []} evidenceSummaries={report.evidenceSummaries ?? []} provenance={report.provenance} />
      <footer className="border-t border-slate-200 px-6 py-4 text-xs text-slate-500 md:px-10">Preview of the read-only client report.</footer>
    </article>
  )
}

function ReportSafeSections({
  journeys,
  incidents,
  recoveries,
  evidenceSummaries,
  provenance,
  publicEvidenceToken,
}: {
  journeys: ReportJourneyCoverage[]
  incidents: ReportIncidentSummary[]
  recoveries: ReportIncidentSummary[]
  evidenceSummaries: ReportEvidenceSummary[]
  provenance?: ReportProvenance
  publicEvidenceToken?: string
}) {
  const recentEvidence = [...evidenceSummaries]
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
    .slice(0, 8)
  const screenshots = reportSafeScreenshots(evidenceSummaries)
  return (
    <>
      <section className="border-t border-slate-200 px-6 py-8 md:px-10">
        <h3 className="text-lg font-semibold text-slate-950">Journey coverage</h3>
        <p className="mt-2 text-sm text-slate-500">Immutable journey versions with complete stage evidence during this reporting period.</p>
        {journeys.length ? <div className="mt-4 overflow-x-auto rounded-md border border-slate-200"><table className="w-full min-w-[620px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3 font-medium">Journey</th><th className="px-4 py-3 font-medium">Template</th><th className="px-4 py-3 font-medium">Runs</th><th className="px-4 py-3 font-medium">Latest outcome</th><th className="px-4 py-3 font-medium">Latest run</th></tr></thead><tbody className="divide-y divide-slate-200">{journeys.map((journey) => <tr key={journey.journeyId}><td className="px-4 py-3 font-medium text-slate-900">{journey.name}</td><td className="px-4 py-3 text-slate-600">{reportTemplateLabel(journey.template)}</td><td className="px-4 py-3 text-slate-600">{journey.runCount}</td><td className="px-4 py-3"><ReportVerdict value={journey.latestVerdict} /></td><td className="px-4 py-3 text-slate-500">{journey.latestCompletedAt ? formatApiDate(journey.latestCompletedAt) : "—"}</td></tr>)}</tbody></table></div> : <ReportEmptyState>There is no browser-stage journey coverage in this snapshot.</ReportEmptyState>}
      </section>
      <section className="border-t border-slate-200 px-6 py-8 md:px-10">
        <h3 className="text-lg font-semibold text-slate-950">Report-safe eval evidence</h3>
        <p className="mt-2 text-sm text-slate-500">Recent deterministic outcomes and stage limitations. Showing {recentEvidence.length} of {evidenceSummaries.length} retained run summaries.</p>
        {recentEvidence.length ? <div className="mt-4 grid gap-3">{recentEvidence.map((run) => <article key={run.runId} className="rounded-md border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">{run.summary || "Configured journey evaluation"}</p><p className="mt-1 text-xs text-slate-500">{run.completedAt ? formatApiDate(run.completedAt) : "Completion time unavailable"} · {formatDurationMs(run.durationMs)} · cleanup {run.cleanupStatus.replaceAll("_", " ")}</p></div><ReportVerdict value={run.verdict} /></div>{run.businessImpact ? <p className="mt-3 text-sm leading-6 text-slate-600">{run.businessImpact}</p> : null}<div className="mt-3 flex flex-wrap gap-2">{run.stages.map((stage) => <span key={`${run.runId}-${stage.position}`} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600">Stage {stage.position + 1}: {stage.verdict}{stage.durationMs !== null ? ` · ${formatDurationMs(stage.durationMs)}` : ""}{stage.errorCode ? ` · ${stage.errorCode}` : ""}</span>)}</div></article>)}</div> : <ReportEmptyState>No browser-run evidence summaries are available for this report.</ReportEmptyState>}
      </section>
      <section className="grid border-t border-slate-200 md:grid-cols-2">
        <div className="px-6 py-8 md:px-10"><h3 className="text-lg font-semibold text-slate-950">Incidents</h3><p className="mt-2 text-sm text-slate-500">Reportable failures and their current snapshot state.</p><ReportIncidentList incidents={incidents} empty="No reportable incidents were recorded in this period." /></div>
        <div className="border-t border-slate-200 px-6 py-8 md:border-l md:border-t-0 md:px-10"><h3 className="text-lg font-semibold text-slate-950">Verified recoveries</h3><p className="mt-2 text-sm text-slate-500">Resolved incidents backed by a linked passing verification rerun.</p><ReportIncidentList incidents={recoveries} empty="No verified recoveries were recorded in this period." recovery /></div>
      </section>
      {publicEvidenceToken && screenshots.length ? <section className="border-t border-slate-200 px-6 py-8 md:px-10"><h3 className="text-lg font-semibold text-slate-950">Report-safe screenshots</h3><p className="mt-2 text-sm text-slate-500">Redacted screenshots explicitly retained as client-safe evidence.</p><div className="mt-4 grid gap-4 sm:grid-cols-2">{screenshots.map((artifact, index) => <figure key={artifact.artifactId} className="overflow-hidden rounded-md border border-slate-200 bg-slate-50"><Image unoptimized src={`/api/share/reports/${encodeURIComponent(publicEvidenceToken)}/evidence/${encodeURIComponent(artifact.artifactId)}`} alt={`Report-safe journey evidence ${index + 1}`} width={960} height={540} className="aspect-video h-auto w-full object-contain" /><figcaption className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500">Redacted screenshot {index + 1}</figcaption></figure>)}</div></section> : null}
      {provenance ? <section className="border-t border-slate-200 bg-slate-50/60 px-6 py-6 md:px-10"><h3 className="text-sm font-semibold text-slate-900">Evidence provenance</h3><dl className="mt-3 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-500">Snapshot</dt><dd className="mt-1 font-medium text-slate-900">Version {provenance.snapshotVersion} · schema {provenance.schemaVersion}</dd></div><div><dt className="text-slate-500">Generated</dt><dd className="mt-1 font-medium text-slate-900">{provenance.generatedAt ? formatApiDate(provenance.generatedAt) : "Unavailable"}</dd></div><div><dt className="text-slate-500">Evidence fingerprint</dt><dd className="mt-1 break-all font-mono text-[11px] text-slate-900">{provenance.evidenceFingerprint || "Legacy snapshot — no Business Evals fingerprint"}</dd></div></dl></section> : null}
    </>
  )
}

function ReportIncidentList({ incidents, empty, recovery = false }: { incidents: ReportIncidentSummary[]; empty: string; recovery?: boolean }) {
  return incidents.length ? <div className="mt-4 grid gap-3">{incidents.map((incident) => <article key={`${recovery ? "recovery" : "incident"}-${incident.incidentId}`} className="rounded-md border border-slate-200 bg-white p-4"><div className="flex items-start justify-between gap-3"><p className="font-medium text-slate-900">{incident.title}</p><span className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${recovery ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{recovery ? "verified" : incident.status.replaceAll("_", " ")}</span></div><p className="mt-2 text-sm leading-6 text-slate-600">{incident.reportSafeSummary || "No additional report-safe detail was recorded."}</p><p className="mt-2 text-xs capitalize text-slate-500">{incident.severity} severity{recovery && incident.resolvedAt ? ` · verified ${formatApiDate(incident.resolvedAt)}` : ""}</p></article>)}</div> : <ReportEmptyState>{empty}</ReportEmptyState>
}

function ReportVerdict({ value }: { value: ReportJourneyCoverage["latestVerdict"] }) {
  const tone = value === "passed" ? "bg-emerald-50 text-emerald-700" : value === "failed" ? "bg-red-50 text-red-700" : value === "degraded" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-700"
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium capitalize ${tone}`}>{value.replaceAll("_", " ")}</span>
}

function ReportEmptyState({ children }: { children: string }) { return <p className="mt-4 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">{children}</p> }

function reportSafeScreenshots(evidenceSummaries: ReportEvidenceSummary[]) {
  const unique = new Map<string, ReportEvidenceSummary["stages"][number]["artifacts"][number]>()
  for (const run of evidenceSummaries) for (const stage of run.stages) for (const artifact of stage.artifacts) if (!unique.has(artifact.artifactId)) unique.set(artifact.artifactId, artifact)
  return [...unique.values()].slice(0, 6)
}

function reportTemplateLabel(template: ReportJourneyCoverage["template"]) { return template === "trial_signup" ? "Trial signup" : template === "lead_form" ? "Lead form" : "Legacy endpoint" }
function formatReportPeriod(start: string, end: string) { return `${new Date(start).toLocaleDateString("en-IE")}–${new Date(end).toLocaleDateString("en-IE")}` }
function formatDurationMs(value: number | null) { if (value === null) return "Duration unavailable"; if (value < 1_000) return `${value} ms`; if (value < 60_000) return `${Math.round(value / 100) / 10}s`; return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s` }

function ReportMetric({ label, value }: { label: string; value: string | number }) { return <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-3"><span className="text-slate-500">{label}</span><span className="font-medium capitalize text-slate-900">{value}</span></div> }
function PublicReportState({ title, description }: { title: string; description: string }) { return <main className="flex min-h-dvh items-center justify-center bg-[#fbfaf7] p-5"><Card className="max-w-md rounded-lg border border-slate-200 bg-white shadow-sm ring-0"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card></main> }

function dateInputDaysAgo(days: number) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - days)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

async function responseErrorMessage(response: Response, fallback: string) {
  const body = await response.text().catch(() => "")
  if (!body) return fallback
  try {
    const payload = JSON.parse(body) as { message?: string; error?: string | { message?: string } }
    if (typeof payload.message === "string") return payload.message
    if (typeof payload.error === "string") return payload.error
    if (payload.error && typeof payload.error === "object" && typeof payload.error.message === "string") return payload.error.message
  } catch {
    return body.slice(0, 300)
  }
  return fallback
}

function safeDownloadFilename(disposition: string | null, fallback: string) {
  const match = disposition?.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i)
  const encoded = match?.[1]?.trim() ?? fallback
  let candidate = encoded
  try { candidate = decodeURIComponent(encoded) } catch { candidate = fallback }
  const safe = candidate.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-")
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`
}

function formatApiDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short" }).format(date)
}

function shareLinkState(link: EvalReportShare) {
  if (link.revokedAt) return "revoked"
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return "expired"
  return "active"
}
