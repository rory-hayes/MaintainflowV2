"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { businessEvalsRequest, createIdempotencyKey } from "@/lib/api/business-evals-client"
import { aiRunDiagnosisResponseSchema, evidenceAccessResponseSchema } from "@/lib/api/business-evals-response-schemas"
import { IconArrowLeft, IconPhoto, IconPlayerPlay, IconPlayerStop, IconShieldCheck } from "@tabler/icons-react"
import Image from "next/image"
import Link from "next/link"
import { useEffect, useState, type ReactNode } from "react"
import { useEvals } from "../evals-provider"
import {
  EvalRunAiDiagnosisPanel,
  type EvalRunAiDiagnosis,
} from "../ai-draft-review"
import { CollectionLoadMore, EvalBreadcrumbs, EvalPage, EmptyPanel, MetricCard, PageHeading } from "../page-primitives"
import { StatusLabel } from "../status-ui"
import type { EvalEvidenceArtifact, EvalStageEvidence } from "../types"

export function EvalRunsPage() {
  const { runs, journeyFor, pagination } = useEvals()
  return (
    <EvalPage>
      <PageHeading title="Eval runs" description="A chronological evidence ledger for every scheduled and manual journey evaluation." />
      <section className="mb-6 grid gap-3 sm:grid-cols-3">
        <MetricCard label="Runs in view" value={runs.length} detail="Newest first" />
        <MetricCard label="Passed" value={runs.filter((run) => run.status === "passed").length} detail="Business outcome proven" />
        <MetricCard label="Needs attention" value={runs.filter((run) => run.status === "failed" || run.status === "degraded").length} detail="Failed or degraded" />
      </section>
      <Card className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0">
        <CardContent className="px-3 py-2 md:px-4">
          <Table>
            <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Journey</TableHead><TableHead>Status</TableHead><TableHead>Duration</TableHead><TableHead>Business impact</TableHead><TableHead>Trigger</TableHead></TableRow></TableHeader>
            <TableBody>{runs.map((run) => {
              const journey = journeyFor(run.journeyId)
              return <TableRow key={run.id}><TableCell><Link href={`/eval-runs/${run.id}`} className="font-medium text-slate-900 hover:text-blue-600">{run.startedAt}</Link></TableCell><TableCell><Link href={`/journeys/${run.journeyId}`} className="hover:text-blue-600">{journey?.name ?? run.journeyName ?? run.journeyId}</Link></TableCell><TableCell><StatusLabel status={run.status} compact /></TableCell><TableCell>{run.duration}</TableCell><TableCell>{run.impact}</TableCell><TableCell>{run.triggeredBy}</TableCell></TableRow>
            })}</TableBody>
          </Table>
        </CardContent>
      </Card>
      <CollectionLoadMore state={pagination.runs} label="runs" />
    </EvalPage>
  )
}

export function EvalRunDetailPage({ runId }: { runId: string }) {
  const { runs, journeyFor, workspaceId, cancelRun } = useEvals()
  const run = runs.find((item) => item.id === runId)
  const journey = run ? journeyFor(run.journeyId) : undefined
  const [cancelling, setCancelling] = useState(false)
  const [cancelMessage, setCancelMessage] = useState("")
  const [aiDiagnosis, setAiDiagnosis] = useState<EvalRunAiDiagnosis | null>(null)
  const [aiDiagnosisLoading, setAiDiagnosisLoading] = useState(false)
  const [aiDiagnosisError, setAiDiagnosisError] = useState("")
  if (!run || !journey) return <EvalPage><EmptyPanel title="Eval run not found" description="This evidence record does not exist in the current workspace." /></EvalPage>
  const cancellable = run.source !== "legacy_endpoint" && (run.status === "queued" || run.status === "running") && !run.cancelRequestedAt
  const diagnosableStatus = run.status === "failed" || run.status === "inconclusive"
    ? run.status
    : null

  async function requestCancellation() {
    setCancelling(true)
    setCancelMessage("")
    try {
      await cancelRun(runId)
      setCancelMessage("Cancellation requested. Required cleanup will still be attempted before the run finalizes.")
    } catch (cause) {
      setCancelMessage(cause instanceof Error ? cause.message : "The run could not be cancelled.")
    } finally {
      setCancelling(false)
    }
  }

  async function requestAiDiagnosis() {
    if (!diagnosableStatus) return
    if (!workspaceId) {
      setAiDiagnosisError("AI diagnosis is unavailable in the visual preview.")
      return
    }
    setAiDiagnosisLoading(true)
    setAiDiagnosisError("")
    try {
      const response = await businessEvalsRequest(
        "/api/business-evals/ai/run-diagnosis",
        aiRunDiagnosisResponseSchema,
        {
          workspaceId,
          method: "POST",
          idempotencyKey: createIdempotencyKey("ai-run-diagnosis"),
          body: JSON.stringify({ runId }),
        }
      )
      setAiDiagnosis(response.data)
    } catch (cause) {
      setAiDiagnosisError(cause instanceof Error ? cause.message : "AI diagnosis is temporarily unavailable.")
    } finally {
      setAiDiagnosisLoading(false)
    }
  }
  return (
    <EvalPage>
      <EvalBreadcrumbs items={[{ label: "Eval runs", href: "/eval-runs" }, { label: run.startedAt }]} />
      <PageHeading title={journey.name} description={`Immutable evidence from the run started ${run.startedAt}.`} action={<div className="flex flex-wrap gap-2">{cancellable ? <Button variant="outline" onClick={requestCancellation} disabled={cancelling} className="rounded-md border-red-200 text-red-700 hover:bg-red-50"><IconPlayerStop data-icon="inline-start" />{cancelling ? "Requesting…" : "Cancel run"}</Button> : null}<Button nativeButton={false} variant="outline" render={<Link href={`/journeys/${journey.id}`} />} className="rounded-md border-slate-200"><IconArrowLeft data-icon="inline-start" />Journey</Button></div>} />
      {cancelMessage ? <p aria-live="polite" className="mb-4 rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700">{cancelMessage}</p> : null}
      <section className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>{run.source === "legacy_endpoint" ? "Legacy endpoint diagnostic" : "Stage evidence"}</CardTitle><StatusLabel status={run.status} /></div><CardDescription>{run.source === "legacy_endpoint" ? "Deterministic endpoint evidence from the existing Maintain Flow monitor. Browser stage evidence does not apply to this run." : "Expected outcome, observed result, timing, diagnostics and retained screenshots for this exact journey version."}</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            {run.source === "legacy_endpoint" && run.legacyEndpointEvidence
              ? <LegacyEndpointEvidencePanel evidence={run.legacyEndpointEvidence} />
              : run.stageEvidence?.length
              ? run.stageEvidence.map((stage, index) => {
                  const definition = journey.stages.find((item) => item.id === stage.definitionId) ?? journey.stages[stage.position] ?? journey.stages[index]
                  const artifacts = (run.evidenceArtifacts ?? []).filter((artifact) => artifact.stageRunId === stage.id || stage.evidenceArtifactIds.includes(artifact.id))
                  return <StageEvidenceCard key={stage.id} stage={stage} stageName={definition?.name ?? `Stage ${index + 1}`} stageNumber={index + 1} artifacts={artifacts} runId={run.id} workspaceId={workspaceId} />
                })
              : journey.stages.map((stage, index) => <div key={stage.id} className="grid gap-3 border-t border-slate-200 py-4 first:border-t-0 md:grid-cols-[36px_190px_1fr]"><span className="flex size-7 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{index + 1}</span><span><span className="block font-medium text-slate-950">{stage.name}</span><StatusLabel status={stage.status} compact className="mt-1" /></span><span className="text-sm leading-6 text-slate-600">{stage.observed}</span></div>)}
          </CardContent>
        </Card>
        <aside className="flex h-fit flex-col gap-4">
          <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0">
            <CardHeader><CardTitle>Run summary</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <Summary label="Status"><StatusLabel status={run.status} /></Summary>
              <Summary label="Run ID"><code className="break-all text-xs">{run.id}</code></Summary>
              <Summary label="Version"><code className="break-all text-xs">{run.source === "legacy_endpoint" ? "Legacy endpoint monitor" : run.journeyVersionId ?? "Not recorded"}</code></Summary>
              <Summary label="Started">{run.startedAt}</Summary>
              <Summary label="Completed">{run.completedAt ?? "Not completed"}</Summary>
              <Summary label="Duration">{run.duration}</Summary>
              <Summary label="Triggered by">{run.triggeredBy}</Summary>
              <Summary label="Runner">{run.runnerProvider || "Not recorded"}</Summary>
              <Summary label="Impact">{run.impact}</Summary>
              <Summary label="Cleanup"><span className="capitalize">{run.cleanupStatus?.replaceAll("_", " ") ?? "Not recorded"}</span></Summary>
              {run.cancelRequestedAt ? <Summary label="Cancellation">Requested {run.cancelRequestedAt}</Summary> : null}
              {run.cleanupErrorSummary ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-700">{run.cleanupErrorSummary}</p> : null}
              {run.summary ? <p className="rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-600">{run.summary}</p> : null}
              <Button nativeButton={false} render={<Link href={`/journeys/${journey.id}`} />} className="mt-2 w-full rounded-md bg-blue-600 hover:bg-blue-700"><IconPlayerPlay data-icon="inline-start" />Open journey</Button>
              <p className="flex items-start gap-2 text-xs leading-5 text-slate-500"><IconShieldCheck className="mt-0.5 size-4 shrink-0" />This run is bound to the immutable version above. Evidence access is tenant-scoped and time-limited.</p>
            </CardContent>
          </Card>
          {diagnosableStatus ? (
            <EvalRunAiDiagnosisPanel
              status={diagnosableStatus}
              diagnosis={aiDiagnosis}
              loading={aiDiagnosisLoading}
              error={aiDiagnosisError}
              onRequest={() => void requestAiDiagnosis()}
            />
          ) : null}
        </aside>
      </section>
    </EvalPage>
  )
}

function LegacyEndpointEvidencePanel({ evidence }: { evidence: NonNullable<ReturnType<typeof useEvals>["runs"][number]["legacyEndpointEvidence"]> }) {
  return <article className="overflow-hidden rounded-lg border border-slate-200"><header className="border-b border-slate-200 bg-slate-50/70 px-4 py-4"><p className="font-medium text-slate-950">{evidence.checkName}</p><p className="mt-1 text-xs text-slate-500">Check ID {evidence.checkId || "not recorded"} · {evidence.evidenceOrigin === "service" ? "Service probe" : "Legacy browser probe"}</p></header><div className="grid gap-4 px-4 py-4 sm:grid-cols-2"><EvidenceValue label="HTTP status" value={evidence.statusCode === null ? "Not recorded" : String(evidence.statusCode)} /><EvidenceValue label="Latency" value={evidence.latencyMs === null ? "Not recorded" : `${evidence.latencyMs} ms`} /><EvidenceValue label="Safe response summary" value={evidence.safeResponseSummary || "No report-safe response summary was recorded."} /><EvidenceValue label="Monitor error" value={evidence.errorMessage || "None"} /></div>{evidence.assertionResults.length ? <section className="border-t border-slate-200 px-4 py-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Deterministic assertions</p><SafeJsonDetails label="Assertion results" value={evidence.assertionResults} /></section> : null}<footer className="border-t border-slate-200 px-4 py-3 text-xs leading-5 text-slate-500">This compatibility record contains endpoint-monitor diagnostics only. It does not claim browser journey, email, screenshot or cleanup evidence.</footer></article>
}

function StageEvidenceCard({
  stage,
  stageName,
  stageNumber,
  artifacts,
  runId,
  workspaceId,
}: {
  stage: EvalStageEvidence
  stageName: string
  stageNumber: number
  artifacts: EvalEvidenceArtifact[]
  runId: string
  workspaceId: string
}) {
  const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot" && artifact.redacted && (artifact.mimeType === "image/png" || artifact.mimeType === "image/jpeg"))
  return (
    <article className="overflow-hidden rounded-lg border border-slate-200">
      <header className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-4 sm:flex-row sm:items-center">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-600 ring-1 ring-slate-200">{stageNumber}</span>
        <span className="min-w-0 flex-1"><span className="block font-medium text-slate-950">{stageName}</span><span className="mt-1 block text-xs text-slate-500">{stage.startedAt} – {stage.completedAt}</span></span>
        <span className="flex items-center gap-2"><span className="text-xs text-slate-500">{stage.duration}</span><StatusLabel status={stage.verdict} compact /></span>
      </header>
      <div className="grid gap-4 px-4 py-4 md:grid-cols-2">
        <EvidenceValue label="Expected" value={stage.expected} />
        <EvidenceValue label="Observed" value={stage.observed} />
      </div>
      {stage.errorCode ? <p className="mx-4 mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700"><span className="font-semibold">Error code:</span> {stage.errorCode}</p> : null}
      {screenshots.length ? <section className="border-t border-slate-200 px-4 py-4"><p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500"><IconPhoto className="size-4" />Redacted screenshots</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{screenshots.map((artifact, index) => <PrivateEvidenceImage key={artifact.id} artifact={artifact} runId={runId} workspaceId={workspaceId} index={index} />)}</div></section> : null}
      {artifacts.length ? <section className="border-t border-slate-200 px-4 py-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Evidence ledger</p><div className="mt-2 flex flex-col divide-y divide-slate-100">{artifacts.map((artifact) => <div key={artifact.id} className="grid gap-1 py-2 text-xs text-slate-600 sm:grid-cols-[100px_1fr]"><span className="font-medium capitalize text-slate-800">{artifact.kind.replaceAll("_", " ")}</span><span className="break-all">{formatBytes(artifact.byteSize)} · {artifact.mimeType || "unknown type"} · expires {artifact.expiresAt}<br /><span className="text-slate-400">SHA-256 {artifact.sha256 || "not recorded"}</span></span></div>)}</div></section> : null}
      {hasDiagnosticContent(stage.diagnostics) || stage.assertions.length ? <section className="border-t border-slate-200 px-4 py-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Diagnostics</p>{hasDiagnosticContent(stage.diagnostics) ? <SafeJsonDetails label="Runner diagnostics" value={stage.diagnostics} /> : null}{stage.assertions.length ? <SafeJsonDetails label="Assertion results" value={stage.assertions} /> : null}</section> : null}
    </article>
  )
}

function EvidenceValue({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 text-sm leading-6 text-slate-700">{value}</p></div>
}

function PrivateEvidenceImage({ artifact, runId, workspaceId, index }: { artifact: EvalEvidenceArtifact; runId: string; workspaceId: string; index: number }) {
  const [url, setUrl] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    businessEvalsRequest(`/api/eval-runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(artifact.id)}`, evidenceAccessResponseSchema, { workspaceId })
      .then((result) => { if (active) setUrl(result.data.url) })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Evidence is unavailable.") })
    return () => { active = false }
  }, [artifact.id, runId, workspaceId])

  return <figure className="overflow-hidden rounded-md border border-slate-200 bg-slate-50">{url ? <Image unoptimized src={url} alt={`Redacted evidence for stage ${index + 1}`} width={960} height={540} className="aspect-video h-auto w-full object-contain" /> : <div className="flex aspect-video items-center justify-center p-4 text-center text-xs text-slate-500">{error || "Loading time-limited evidence…"}</div>}<figcaption className="border-t border-slate-200 px-3 py-2 text-xs text-slate-500">Captured {artifact.createdAt} · {artifact.redacted ? "redacted" : "private"}</figcaption></figure>
}

function SafeJsonDetails({ label, value }: { label: string; value: unknown }) {
  return <details className="mt-3 rounded-md border border-slate-200"><summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700">{label}</summary><pre className="max-h-80 overflow-auto border-t border-slate-200 bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(redactDiagnosticValue(value), null, 2)}</pre></details>
}

function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]"
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDiagnosticValue(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 80).map(([key, item]) => [
      key,
      /storage|path|secret|token|password|credential|authorization|cookie|session|api.?key|raw.?email/i.test(key)
        ? "[redacted]"
        : redactDiagnosticValue(item, depth + 1),
    ]))
  }
  if (typeof value === "string") {
    return value
      .slice(0, 1_000)
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
      .replace(/([?&](?:token|secret|key|signature)=)[^&\s]+/gi, "$1[redacted]")
  }
  return typeof value === "number" || typeof value === "boolean" || value === null ? value : String(value ?? "")
}

function hasDiagnosticContent(value: unknown) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 104_857.6) / 10} MB`
}

function Summary({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[110px_1fr] gap-3 border-b border-slate-100 pb-3"><span className="text-slate-500">{label}</span><span className="font-medium text-slate-900">{children}</span></div>
}
