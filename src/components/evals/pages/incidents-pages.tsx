"use client"

import { Button } from "@/components/ui/button"
import { useAuth } from "@/components/auth/auth-provider"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { IconAlertTriangle, IconArrowRight, IconCircleCheck } from "@tabler/icons-react"
import Link from "next/link"
import { useState, type ReactNode } from "react"
import { useEvals } from "../evals-provider"
import { CollectionLoadMore, EvalBreadcrumbs, EvalPage, EmptyPanel, PageHeading } from "../page-primitives"
import { IncidentSeverity } from "../status-ui"

export function IncidentsPage() {
  const { incidents, journeyFor, pagination } = useEvals()
  const [filter, setFilter] = useState<"active" | "resolved" | "all">("active")
  const visible = incidents.filter((incident) => filter === "all" || (filter === "resolved" ? incident.status === "resolved" || incident.status === "ignored" : incident.status !== "resolved" && incident.status !== "ignored"))
  return (
    <EvalPage>
      <PageHeading title="Incidents" description="A business-first queue for customer journeys that failed, degraded or became inconclusive." />
      <div className="mb-4 flex w-fit rounded-md border border-slate-200 bg-white p-1">
        {(["active", "resolved", "all"] as const).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded px-3 py-1.5 text-xs font-medium capitalize ${filter === item ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{item}</button>)}
      </div>
      {visible.length ? <div className="flex flex-col gap-3">{visible.map((incident) => {
        const journey = journeyFor(incident.journeyId)
        return (
          <Card key={incident.id} className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0">
            <Link href={`/incidents/${incident.id}`} className="grid gap-4 p-5 transition hover:bg-slate-50 md:grid-cols-[44px_minmax(0,1fr)_150px_24px] md:items-center">
              <span className={`flex size-10 items-center justify-center rounded-full ${incident.status === "resolved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{incident.status === "resolved" ? <IconCircleCheck className="size-5" /> : <IconAlertTriangle className="size-5" />}</span>
              <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-950">{incident.title}</span><IncidentSeverity severity={incident.severity} /></span><span className="mt-1 block truncate text-sm text-slate-600">{incident.summary}</span><span className="mt-2 block text-xs text-slate-500">{journey?.name ?? incident.journeyName ?? "Historical journey"} · Opened {incident.openedAt}</span></span>
              <span className="text-sm"><span className="block capitalize text-slate-900">{incident.status}</span><span className="mt-1 block text-xs text-slate-500">{incident.owner}</span></span>
              <IconArrowRight className="size-4 text-slate-400" />
            </Link>
          </Card>
        )
      })}</div> : <EmptyPanel title="No incidents in this view" description="When a business outcome needs attention, it will appear here with evidence and impact." />}
      <CollectionLoadMore state={pagination.incidents} label="incidents" />
    </EvalPage>
  )
}

export function IncidentDetailPage({ incidentId }: { incidentId: string }) {
  const { incidents, journeyFor, mutateIncident } = useEvals()
  const { user } = useAuth()
  const incident = incidents.find((item) => item.id === incidentId)
  const journey = incident ? journeyFor(incident.journeyId) : undefined
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [repairNote, setRepairNote] = useState(incident?.repairNote ?? "")
  if (!incident || !journey) return <EvalPage><EmptyPanel title="Incident not found" description="This incident does not exist in the current workspace." /></EvalPage>

  async function applyAction(action: "assign" | "snooze" | "record_repair" | "verify") {
    setSaving(true)
    setMessage("")
    try {
      if (action === "assign") {
        if (!user?.id) throw new Error("A signed-in workspace member is required for assignment.")
        await mutateIncident(incident!.id, { action: "assign", ownerUserId: user.id })
        setMessage("Incident assigned to you.")
      } else if (action === "snooze") {
        await mutateIncident(incident!.id, { action: "snooze", until: new Date(Date.now() + 24 * 60 * 60_000).toISOString() })
        setMessage("Incident snoozed for 24 hours.")
      } else if (action === "record_repair") {
        if (!repairNote.trim()) throw new Error("Describe the repair before requesting verification.")
        await mutateIncident(incident!.id, { action: "record_repair", note: repairNote.trim() })
        setMessage(incident!.source === "legacy_endpoint" ? "Repair recorded. The deterministic endpoint monitor must prove recovery on its next check." : "Repair recorded. A verification rerun can now prove recovery.")
      } else {
        if (incident!.source === "legacy_endpoint") throw new Error("Legacy endpoint incidents are verified by the deterministic endpoint monitor, not the browser runner.")
        const result = await mutateIncident(incident!.id, { action: "verify" })
        setMessage(result.status === "passed"
          ? `Verification run ${result.id} passed and is linked as the evidence that resolved this incident.`
          : `Verification run ${result.id} was queued. Only a linked passing rerun can resolve this incident.`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Incident could not be updated.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <EvalPage>
      <EvalBreadcrumbs items={[{ label: "Incidents", href: "/incidents" }, { label: incident.title }]} />
      <PageHeading title={incident.title} description={incident.summary} action={<IncidentSeverity severity={incident.severity} />} />
      <section className="grid gap-5 lg:grid-cols-[1fr_350px]">
        <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader><CardTitle>Business evidence</CardTitle><CardDescription>The latest conclusive evidence and the impact that makes this incident actionable.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Evidence label="Affected journey"><Link href={`/journeys/${journey.id}`} className="font-medium text-blue-600 hover:underline">{journey.name}</Link></Evidence>
            <Evidence label="What happened">{incident.summary}</Evidence>
            <Evidence label="Business impact">{incident.impact}</Evidence>
            <Evidence label="Owner">{incident.owner}</Evidence>
            <Evidence label="Opened">{incident.openedAt}</Evidence>
          </CardContent>
        </Card>
        <Card className="h-fit rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader><CardTitle>Incident action</CardTitle><CardDescription>Update the operational state without changing the underlying evidence.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">Current status: <span className="font-medium capitalize text-slate-950">{incident.status}</span></p>
            {incident.status !== "resolved" && incident.status !== "ignored" ? <><Button onClick={() => applyAction("assign")} disabled={saving || incident.ownerUserId === user?.id} variant="outline" className="rounded-md border-slate-200">Assign to me</Button><Button onClick={() => applyAction("snooze")} disabled={saving} variant="outline" className="rounded-md border-slate-200">Snooze 24 hours</Button><label className="text-sm font-medium text-slate-900">Repair note<Textarea value={repairNote} onChange={(event) => setRepairNote(event.target.value)} className="mt-2" rows={4} placeholder="What changed, in report-safe language?" /></label><Button onClick={() => applyAction("record_repair")} disabled={saving || !repairNote.trim()} className="rounded-md bg-blue-600 hover:bg-blue-700">Record repair</Button>{incident.source === "legacy_endpoint" ? <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">Recovery is verified by the next passing deterministic endpoint check. Browser verification is intentionally unavailable for legacy endpoint coverage.</p> : <Button onClick={() => applyAction("verify")} disabled={saving || (!incident.repairNote && incident.status !== "in_review")} variant="outline" className="rounded-md border-slate-200">Run verification</Button>}</> : <p className={`rounded-md p-3 text-sm ${incident.status === "ignored" ? "bg-slate-100 text-slate-700" : "bg-emerald-50 text-emerald-700"}`}>{incident.status === "ignored" ? "Historical legacy status: ignored. No browser verification action is available." : "Resolved by linked passing verification evidence."}</p>}
            <Button nativeButton={false} render={<Link href={`/journeys/${journey.id}`} />} variant="outline" className="rounded-md border-slate-200">Open journey</Button>
            <p aria-live="polite" className="min-h-5 text-xs text-slate-500">{message}</p>
          </CardContent>
        </Card>
      </section>
    </EvalPage>
  )
}

function Evidence({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-2 border-b border-slate-100 pb-5 md:grid-cols-[160px_1fr]"><p className="text-sm font-medium text-slate-950">{label}</p><div className="text-sm leading-6 text-slate-600">{children}</div></div>
}
