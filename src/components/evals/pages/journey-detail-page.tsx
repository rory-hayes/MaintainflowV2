"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { businessEvalsRequest } from "@/lib/api/business-evals-client"
import { forwardingAddressResponseSchema } from "@/lib/api/business-evals-response-schemas"
import {
  IconAlertTriangle,
  IconCalendar,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDatabase,
  IconExternalLink,
  IconPlayerPlay,
  IconSettings,
  IconStar,
  IconUser,
} from "@tabler/icons-react"
import Link from "next/link"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useEvals } from "../evals-provider"
import { JourneyStageRail } from "../journey-stage-rail"
import { EvalBreadcrumbs, EvalPage, EmptyPanel } from "../page-primitives"
import { journeyStateLabel, StatusIcon, StatusLabel, StatusPill } from "../status-ui"
import type { InteractiveEvalRunMode } from "../types"

export function JourneyDetailPage({ journeyId }: { journeyId: string }) {
  const { journeyFor, projectFor, runs, runJourney, workspaceId } = useEvals()
  const journey = journeyFor(journeyId)
  const project = journey ? projectFor(journey.projectId) : undefined
  const [selectedStageId, setSelectedStageId] = useState(journey?.stages.find((stage) => stage.status === "degraded" || stage.status === "failed")?.id ?? journey?.stages[0]?.id ?? "")
  const [running, setRunning] = useState(false)
  const [runMessage, setRunMessage] = useState("")
  const [copyMessage, setCopyMessage] = useState("")
  const [forwardingRecipient, setForwardingRecipient] = useState("")
  const journeyRuns = useMemo(() => runs.filter((run) => run.journeyId === journeyId), [journeyId, runs])

  useEffect(() => {
    // Preview providers intentionally have no production workspace identifier.
    // Never let fixture-backed design QA fall through to an authenticated API.
    if (!workspaceId) return
    let active = true
    businessEvalsRequest(`/api/journeys/${encodeURIComponent(journeyId)}/forwarding-address`, forwardingAddressResponseSchema, { workspaceId })
      .then((result) => { if (active) setForwardingRecipient(result.data.forwardingRecipient ?? "") })
      // The endpoint is owner/admin-only. Members can still use the rest of the
      // journey page, so authorization failures are deliberately non-fatal.
      .catch(() => undefined)
    return () => { active = false }
  }, [journeyId, workspaceId])

  if (!journey || !project) {
    return <EvalPage><EmptyPanel title="Journey not found" description="This journey does not exist in the current workspace." action={<Button nativeButton={false} render={<Link href="/journeys" />}>Back to journeys</Button>} /></EvalPage>
  }

  const selectedStage = journey.stages.find((stage) => stage.id === selectedStageId) ?? journey.stages[0]
  const latestRun = journeyRuns[0]
  const currentJourneyId = journey.id

  async function handleRun(mode: InteractiveEvalRunMode = "manual") {
    setRunning(true)
    setRunMessage(mode === "debug" ? "Queueing run with private debug capture…" : mode === "supervised" ? "Queueing supervised run…" : "Queueing journey run…")
    try {
      const result = await runJourney(currentJourneyId, mode)
      setRunMessage(`Run ${result.id} is ${result.status}. Open it for live evidence.`)
    } catch (error) {
      setRunMessage(error instanceof Error ? error.message : "The run could not be started.")
    } finally {
      setRunning(false)
    }
  }

  return (
    <EvalPage className="pt-3">
      <EvalBreadcrumbs items={[
        { label: "Projects", href: "/projects" },
        { label: project.name, href: `/projects/${project.id}` },
        { label: "Journeys", href: "/journeys" },
      ]} />

      <div className="mb-7 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-4">
            <h1 className="text-[2.4rem] font-semibold leading-none tracking-[-0.045em] text-slate-950 md:text-[3.5rem]">{journey.name}</h1>
            <IconStar aria-hidden className="hidden size-6 shrink-0 text-slate-500 sm:block" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-xl font-semibold text-slate-950">
              {journey.status === "degraded" || journey.status === "failed" ? <IconAlertTriangle className="size-7 text-amber-600" /> : <StatusIcon status={journey.status} className="size-6" />}
              {journeyStateLabel(journey.status)}
            </span>
            <span aria-hidden className="text-slate-400">•</span>
            <span className="text-sm text-slate-500">Last run: {journey.lastRunAt}</span>
            <span aria-hidden className="text-slate-400">•</span>
            <span className="text-sm font-medium text-slate-700">Coverage: {journeyCoverageLabel(journey)}</span>
          </div>
          <p className="mt-4 text-sm text-slate-600">{journey.description}</p>
          {forwardingRecipient ? <div className="mt-3 flex max-w-2xl flex-col gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 sm:flex-row sm:items-center"><span className="min-w-0 flex-1"><span className="block text-xs font-medium uppercase tracking-wide text-blue-700">Forward destination notifications here</span><code className="mt-1 block break-all text-sm text-slate-800">{forwardingRecipient}</code><span className="mt-1 block text-xs text-slate-500">Preserve the exact MF-EVAL marker in the forwarded message.</span></span><Button type="button" variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(forwardingRecipient); setCopyMessage("Copied") } catch { setCopyMessage("Copy unavailable") } }} className="shrink-0 rounded-md border-slate-200 bg-white"><IconCopy data-icon="inline-start" />{copyMessage || "Copy"}</Button></div> : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="mt-4 rounded-md border-slate-200 bg-white text-slate-800 shadow-none" />}>
            <IconSettings data-icon="inline-start" /> Journey settings <IconChevronDown data-icon="inline-end" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<Link href={`/journeys/${journey.id}/edit`} />}>Edit journey</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <JourneyStageRail stages={journey.stages} selectedId={selectedStage.id} onSelect={setSelectedStageId} />

      <div className="mx-auto w-full lg:max-w-[1365px]">
        <section className="mb-4 grid gap-5 lg:grid-cols-[1.45fr_1fr]">
          <EvidencePanel stage={selectedStage} stageIndex={journey.stages.findIndex((stage) => stage.id === selectedStage.id)} stageCount={journey.stages.length} runId={latestRun?.id} />
          <RunPanel
            latestRun={latestRun}
            schedule={journey.schedule}
            owner={journey.owner}
            environment={journey.environment}
            running={running}
            message={runMessage}
            onRun={handleRun}
            legacy={journey.template === "legacy_endpoint"}
          />
        </section>

        <RecentRuns runs={journeyRuns.slice(0, 5)} />
        <p className="mt-2 text-right text-xs text-slate-500">All times shown in Europe/Dublin</p>
      </div>
    </EvalPage>
  )
}

function journeyCoverageLabel(journey: ReturnType<typeof useEvals>["journeys"][number]) {
  if (journey.template === "legacy_endpoint") return "Legacy endpoint"
  if (journey.template === "trial_signup") return "Browser + email + cleanup"
  if (journey.rawDraft?.emailProofConfigured) return "Browser + email"
  return "Browser only"
}

function EvidencePanel({ stage, stageIndex, stageCount, runId }: { stage: NonNullable<ReturnType<typeof useEvals>["journeys"][number]["stages"][number]>; stageIndex: number; stageCount: number; runId?: string }) {
  return (
    <Card className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0">
      <CardHeader className="px-6 py-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">{stage.name}</CardTitle>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"><StatusLabel status={stage.status} compact /></span>
        </div>
        <p className="text-sm text-slate-500">Stage {stageIndex + 1} of {stageCount}</p>
      </CardHeader>
      <CardContent className="px-6 py-0">
        <EvidenceRow label="What was expected">
          <p>{stage.expected}</p>
        </EvidenceRow>
        <EvidenceRow label="What we observed">
          <p>{stage.observed}</p>
          {stage.evidenceLabel && runId ? <Link href={`/eval-runs/${runId}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline">{stage.evidenceLabel}<IconExternalLink className="size-4" /></Link> : null}
        </EvidenceRow>
        <EvidenceRow label="Business impact" last>
          <p>{stage.impact}</p>
        </EvidenceRow>
      </CardContent>
    </Card>
  )
}

function EvidenceRow({ label, children, last = false }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={`grid gap-3 py-2.5 text-sm leading-5 text-slate-700 md:grid-cols-[205px_1fr] ${last ? "" : "border-b border-slate-200"}`}>
      <p className="font-medium text-slate-950">{label}</p>
      <div className="max-w-[440px]">{children}</div>
    </div>
  )
}

function RunPanel({
  latestRun,
  schedule,
  owner,
  environment,
  running,
  message,
  onRun,
  legacy,
}: {
  latestRun?: ReturnType<typeof useEvals>["runs"][number]
  schedule: string
  owner: string
  environment: string
  running: boolean
  message: string
  onRun: (mode?: InteractiveEvalRunMode) => void
  legacy: boolean
}) {
  return (
    <Card className="gap-0 rounded-lg border border-slate-200 bg-white py-3 shadow-none ring-0">
      <CardContent className="px-5">
        <RunMeta icon={IconClock} label="Latest run" value={latestRun?.startedAt ?? "Not run yet"} trailing={latestRun ? <StatusPill status={latestRun.status} /> : null} />
        <RunMeta icon={IconCalendar} label="Schedule" value={schedule} />
        <RunMeta icon={IconUser} label="Owner" value={owner} />
        <RunMeta icon={IconDatabase} label="Environment" value={environment} last />
        {legacy ? <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">Legacy endpoint coverage remains managed by the existing deterministic endpoint monitor. Browser eval runs are unavailable for this template.</div> : <><Button onClick={() => onRun("manual")} disabled={running} className="mt-4 h-10 w-full rounded-md bg-blue-600 hover:bg-blue-700"><IconPlayerPlay data-icon="inline-start" /> {running ? "Queueing…" : latestRun ? "Run again" : "Run journey"}</Button><button type="button" onClick={() => onRun("debug")} disabled={running} className="mx-auto mt-2 block text-xs font-medium text-blue-600 underline-offset-4 hover:underline disabled:opacity-50">Run with debug capture</button></>}
        <p aria-live="polite" className={message ? "mt-1 min-h-4 text-center text-xs text-slate-500" : "sr-only"}>{message}</p>
      </CardContent>
    </Card>
  )
}

function RunMeta({ icon: Icon, label, value, trailing, last = false }: { icon: typeof IconClock; label: string; value: string; trailing?: ReactNode; last?: boolean }) {
  return (
    <div className={`grid grid-cols-[24px_105px_1fr_auto] items-center gap-2 py-2.5 text-sm ${last ? "" : "border-b border-slate-200"}`}>
      <Icon aria-hidden className="size-[18px] text-slate-500" />
      <span className="font-medium text-slate-800">{label}</span>
      <span className="min-w-0 truncate text-slate-700">{value}</span>
      {trailing}
    </div>
  )
}

function RecentRuns({ runs }: { runs: ReturnType<typeof useEvals>["runs"] }) {
  return (
    <Card className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0">
      <CardHeader className="px-6 py-1.5"><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
      <CardContent className="px-3 pb-0 md:px-4">
        <div className="hidden md:block">
          <Table className="table-fixed">
            <TableHeader><TableRow><TableHead className="h-7 w-[206px]">Time</TableHead><TableHead className="h-7 w-[176px]">Status</TableHead><TableHead className="h-7 w-[170px]">Duration</TableHead><TableHead className="h-7 w-[276px]">Degraded stage</TableHead><TableHead className="h-7 w-[286px]">Impact</TableHead><TableHead className="h-7">Triggered by</TableHead></TableRow></TableHeader>
            <TableBody>{runs.map((run) => <TableRow key={run.id} className="text-xs"><TableCell className="px-2 py-[5px]"><Link href={`/eval-runs/${run.id}`} className="hover:text-blue-600">{run.startedAt}</Link></TableCell><TableCell className="px-2 py-[5px]"><StatusLabel status={run.status} compact /></TableCell><TableCell className="px-2 py-[5px]">{run.duration}</TableCell><TableCell className="px-2 py-[5px] font-medium text-amber-700">{run.degradedStage ?? "—"}</TableCell><TableCell className="px-2 py-[5px]">{run.impact}</TableCell><TableCell className="px-2 py-[5px]">{run.triggeredBy}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
        <div className="flex flex-col divide-y divide-slate-200 md:hidden">
          {runs.map((run) => (
            <Link key={run.id} href={`/eval-runs/${run.id}`} className="grid grid-cols-[1fr_auto] gap-2 px-2 py-3 text-sm hover:bg-slate-50">
              <span><span className="block font-medium text-slate-900">{run.startedAt}</span><span className="mt-1 block text-xs text-slate-500">{run.duration} · {run.triggeredBy}</span></span>
              <StatusLabel status={run.status} compact />
            </Link>
          ))}
        </div>
        <Link href="/eval-runs" className="inline-block px-2 py-1 text-sm font-medium text-blue-600 hover:underline">View all runs</Link>
      </CardContent>
    </Card>
  )
}
