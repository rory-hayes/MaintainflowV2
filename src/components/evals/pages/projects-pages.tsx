"use client"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { IconArrowRight, IconBuilding, IconRoute } from "@tabler/icons-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"
import { businessEvalsRequest } from "@/lib/api/business-evals-client"
import {
  journeyResponseSchema as projectJourneyResponseSchema,
  projectAuthorizationResponseSchema,
  projectResponseSchema,
} from "@/lib/api/business-evals-response-schemas"
import { useEvals } from "../evals-provider"
import { CollectionLoadMore, EvalBreadcrumbs, EvalPage, MetricCard, PageHeading } from "../page-primitives"
import { StatusLabel } from "../status-ui"

export function ProjectsPage() {
  const { projects, journeys, pagination, setActiveProjectId } = useEvals()
  const searchParams = useSearchParams()
  const requestedTemplate = signupJourneyTemplate(searchParams.get("template"))
  const activeJourneys = projects.reduce((total, project) => total + (project.activeJourneys ?? 0), 0)
  const openIncidents = projects.reduce((total, project) => total + (project.openIncidents ?? 0), 0)
  const healthyProjects = projects.filter((project) => project.health === "healthy").length
  return (
    <EvalPage>
      <PageHeading title="Projects" description="Group business-critical journeys by product or client, then see what is healthy and what needs action." action={<ProjectEditor defaultOpen={searchParams.get("create") === "1"} continuationTemplate={requestedTemplate} />} />
      <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={pagination.projects.hasMore ? "Projects loaded" : "Active projects"} value={projects.length} detail={pagination.projects.hasMore ? "Load more below for the full registry" : "Production and staging"} />
        <MetricCard label="Critical journeys" value={activeJourneys} detail="Across loaded projects" />
        <MetricCard label="Healthy projects" value={healthyProjects} detail="Latest conclusive result" />
        <MetricCard label="Open incidents" value={openIncidents} detail="Business outcomes at risk" />
      </section>
      <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => {
          const projectJourneys = journeys.filter((journey) => journey.projectId === project.id && !journey.archivedAt)
          const degraded = project.health === "failed" || project.health === "degraded" ? "Review" : "0"
          return (
            <Card key={project.id} className="rounded-lg border border-slate-200 bg-white py-5 shadow-none ring-0 transition hover:border-slate-300 hover:shadow-sm">
              <CardHeader className="px-5">
                <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-blue-50 text-blue-600"><IconBuilding className="size-5" /></div>
                <div className="flex items-center justify-between gap-3"><CardTitle className="text-lg">{project.name}</CardTitle><StatusLabel status={projectHealthStatus(project.health, projectJourneys)} compact /></div>
                <CardDescription>{project.domain} · {project.environment}</CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <p className="min-h-12 text-sm leading-6 text-slate-600">{project.description}</p>
                <div className="mt-5 grid grid-cols-2 gap-x-3 gap-y-4 border-y border-slate-100 py-4 text-sm">
                  <div><span className="block text-xs text-slate-500">Active journeys</span><span className="mt-1 block font-semibold text-slate-950">{project.activeJourneys ?? projectJourneys.length}</span><span className="mt-1 block text-[11px] text-slate-500">{project.businessEvalJourneys ?? projectJourneys.filter((journey) => journey.source !== "legacy_endpoint").length} business · {project.legacyEndpointJourneys ?? projectJourneys.filter((journey) => journey.source === "legacy_endpoint").length} legacy</span></div>
                  <div><span className="block text-xs text-slate-500">Open incidents</span><span className="mt-1 block font-semibold text-slate-950">{project.openIncidents ?? 0}</span><span className="mt-1 block text-[11px] text-slate-500">{degraded === "Review" ? "Journey health needs review" : "No current health warning"}</span></div>
                  <div><span className="block text-xs text-slate-500">Last run</span><span className="mt-1 block text-xs font-medium text-slate-800">{project.lastRunAt ?? "Not run yet"}</span></div>
                  <div><span className="block text-xs text-slate-500">Owner</span><span className="mt-1 block truncate text-xs font-medium text-slate-800" title={project.ownerEmail || project.owner}>{project.owner}</span>{project.ownerEmail ? <span className="mt-1 block truncate text-[11px] text-slate-500" title={project.ownerEmail}>{project.ownerEmail}</span> : null}</div>
                  <div><span className="block text-xs text-slate-500">Report status</span><span className="mt-1 block text-xs font-medium capitalize text-slate-800">{project.reportStatus ?? "Not created"}</span></div>
                </div>
                <Button
                  nativeButton={false}
                  render={<Link href={`/projects/${project.id}`} />}
                  onClick={() => setActiveProjectId(project.id)}
                  variant="outline"
                  className="mt-4 w-full rounded-md border-slate-200 shadow-none"
                >
                  Open project <IconArrowRight data-icon="inline-end" />
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </section>
      <CollectionLoadMore state={pagination.projects} label="projects" />
    </EvalPage>
  )
}

export function ProjectDetailPage({ projectId }: { projectId: string }) {
  const { projectFor, journeys, incidents, reports, setActiveProjectId, pagination } = useEvals()
  const project = projectFor(projectId)
  const searchParams = useSearchParams()
  const requestedTemplate = signupJourneyTemplate(searchParams.get("template"))
  const newJourneyHref = `/journeys/new?${new URLSearchParams({ project: projectId, ...(requestedTemplate ? { template: requestedTemplate } : {}) }).toString()}`
  const authorized = project?.authorization?.state === "current"
  useEffect(() => {
    if (project?.id) setActiveProjectId(project.id)
  }, [project?.id, setActiveProjectId])
  if (!project) return <EvalPage><PageHeading title="Project not found" description="This project does not exist in the current workspace." /></EvalPage>
  const projectJourneys = journeys.filter((journey) => journey.projectId === project.id)
  const activeProjectJourneys = projectJourneys.filter((journey) => !journey.archivedAt)
  const orderedProjectJourneys = [...projectJourneys].sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)))
  const journeyIds = new Set(projectJourneys.map((journey) => journey.id))
  const projectIncidents = incidents.filter((incident) => journeyIds.has(incident.journeyId) && incident.status !== "resolved" && incident.status !== "ignored")
  const projectReports = reports.filter((report) => report.projectId === project.id)
  return (
    <EvalPage>
      <EvalBreadcrumbs items={[{ label: "Projects", href: "/projects" }, { label: project.name }]} />
      <PageHeading
        title={project.name}
        description={project.description}
        action={<div className="flex gap-2"><ProjectEditor project={project} />{authorized ? <Button nativeButton={false} render={<Link href={newJourneyHref} />} className="rounded-md bg-blue-600 hover:bg-blue-700">New journey</Button> : <Button nativeButton={false} render={<Link href="#project-authorization" />} className="rounded-md bg-blue-600 hover:bg-blue-700">Authorize project</Button>}</div>}
      />
      <p className="-mt-4 mb-6 text-sm text-slate-600"><span className="font-medium text-slate-900">Owner:</span> {project.owner}{project.ownerEmail ? ` · ${project.ownerEmail}` : ""}</p>
      <ProjectAuthorization project={project} newJourneyHref={newJourneyHref} />
      <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Project health" value={projectHealthLabel(project.health, projectJourneys)} detail="Latest deterministic evidence" />
        <MetricCard label="Journey coverage" value={activeProjectJourneys.length} detail={`${project.businessEvalJourneys ?? activeProjectJourneys.filter((journey) => journey.source !== "legacy_endpoint").length} business · ${project.legacyEndpointJourneys ?? activeProjectJourneys.filter((journey) => journey.source === "legacy_endpoint").length} legacy`} />
        <MetricCard label="Open incidents" value={project.openIncidents ?? projectIncidents.length} detail="Requires owner action" />
        <MetricCard label="Last evidence" value={project.lastRunAt ?? "Not run yet"} detail="Most recent retained run" />
        <MetricCard label="Report status" value={project.reportStatus ?? projectReports[0]?.status ?? "Not created"} detail="Latest project snapshot" />
      </section>
      <Card className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0">
        <CardHeader className="border-b border-slate-200 px-5 py-4"><CardTitle className="text-base">Journeys</CardTitle><CardDescription>End-to-end business outcomes monitored for this project.</CardDescription></CardHeader>
        <CardContent className="divide-y divide-slate-200 px-0">
          {orderedProjectJourneys.map((journey) => (
            <div key={journey.id} className={`grid gap-3 px-5 py-4 transition hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center ${journey.archivedAt ? "bg-slate-50/70" : ""}`}>
              <Link href={`/journeys/${journey.id}`} className="flex min-w-0 items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600"><IconRoute className="size-5" /></span>
                <span className="min-w-0"><span className="block truncate font-medium text-slate-950">{journey.name}</span><span className="mt-1 block truncate text-xs text-slate-500">{journey.description}</span></span>
              </Link>
              {journey.archivedAt ? <span className="text-xs font-medium text-slate-600">Archived</span> : <StatusLabel status={journey.status} />}
              <span className="text-xs text-slate-500">{journey.archivedAt ? `Archived ${journey.archivedAt}` : journey.lastRunAt}</span>
              <JourneyArchiveControl journey={journey} />
            </div>
          ))}
        </CardContent>
      </Card>
      <CollectionLoadMore state={pagination.journeys} label="journeys" />
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0"><CardHeader><CardTitle className="text-base">Latest failures</CardTitle><CardDescription>Open project incidents linked to deterministic journey evidence.</CardDescription></CardHeader><CardContent className="divide-y divide-slate-100">{projectIncidents.length ? projectIncidents.slice(0, 5).map((incident) => <Link key={incident.id} href={`/incidents/${incident.id}`} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"><span><span className="block text-sm font-medium text-slate-900">{incident.title}</span><span className="mt-1 block text-xs text-slate-500">{incident.openedAt} · {incident.impact}</span></span><span className="text-xs font-medium capitalize text-amber-700">{incident.severity}</span></Link>) : <p className="text-sm text-slate-500">No open failures for this project.</p>}</CardContent></Card>
        <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0"><CardHeader><CardTitle className="text-base">Reports</CardTitle><CardDescription>Project snapshots, pass rate and recovery evidence.</CardDescription></CardHeader><CardContent className="divide-y divide-slate-100">{projectReports.length ? projectReports.slice(0, 5).map((report) => <Link key={report.id} href={`/reports/${report.id}`} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"><span><span className="block text-sm font-medium text-slate-900">{report.title}</span><span className="mt-1 block text-xs text-slate-500">{report.period} · {report.passRate} pass rate</span></span><span className="text-xs font-medium capitalize text-slate-600">{report.status}</span></Link>) : <p className="text-sm text-slate-500">No report snapshot has been created yet.</p>}</CardContent></Card>
      </div>
    </EvalPage>
  )
}

function JourneyArchiveControl({ journey }: { journey: ReturnType<typeof useEvals>["journeys"][number] }) {
  const { workspaceId } = useEvals()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const restoring = Boolean(journey.archivedAt)

  async function submit() {
    setSaving(true)
    setError("")
    try {
      await businessEvalsRequest(
        `/api/journeys/${encodeURIComponent(journey.id)}/archive`,
        projectJourneyResponseSchema,
        { workspaceId, method: restoring ? "DELETE" : "PUT" }
      )
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The journey could not be ${restoring ? "restored" : "archived"}.`)
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" className="rounded-md border-slate-200 bg-white">{restoring ? "Restore" : "Archive"}</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{restoring ? "Restore journey?" : "Archive journey?"}</DialogTitle>
          <DialogDescription>
            {restoring
              ? "The journey will return paused and unscheduled. Resume it only after reviewing its current authorization and configuration."
              : "The journey, versions, runs and evidence will be retained. Scheduling stops immediately and active runs receive a cancellation request so required cleanup can finish safely."}
          </DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button type="button" variant={restoring ? "default" : "destructive"} onClick={() => void submit()} disabled={saving}>
            {saving ? (restoring ? "Restoring…" : "Archiving…") : (restoring ? "Restore journey" : "Archive journey")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProjectEditor({ project, defaultOpen = false, continuationTemplate }: { project?: ReturnType<typeof useEvals>["projects"][number]; defaultOpen?: boolean; continuationTemplate?: "lead_form" | "trial_signup" | null }) {
  const { workspaceId, previewMode, createProject, updateProject, archiveProject } = useEvals()
  const router = useRouter()
  const [open, setOpen] = useState(defaultOpen)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setSaving(true); setError("")
    try {
      const kindValue = String(data.get("kind") ?? "client_site")
      const kind: "own_product" | "client_site" | "personal" = kindValue === "own_product" || kindValue === "personal" ? kindValue : "client_site"
      const body = { name: String(data.get("name") ?? ""), website: String(data.get("website") ?? ""), kind, reportRecipientEmail: String(data.get("recipient") ?? ""), notes: String(data.get("notes") ?? "") }
      const result = previewMode
        ? project ? await updateProject(project.id, body) : await createProject(body)
        : (await businessEvalsRequest(project ? `/api/projects/${encodeURIComponent(project.id)}` : "/api/projects", projectResponseSchema, { workspaceId, method: project ? "PATCH" : "POST", body: JSON.stringify(body) })).data
      setOpen(false)
      if (project) {
        if (previewMode) router.refresh()
        else window.location.reload()
      }
      else {
        const query = new URLSearchParams({ authorize: "1" })
        if (continuationTemplate) query.set("template", continuationTemplate)
        const href = `/projects/${encodeURIComponent(result.id)}?${query.toString()}#project-authorization`
        if (previewMode) router.push(href)
        else window.location.assign(href)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The project could not be saved.") } finally { setSaving(false) }
  }
  async function archive() {
    if (!project) return
    setSaving(true); setError("")
    try {
      if (previewMode) {
        await archiveProject(project.id)
        setOpen(false)
        router.push("/projects")
      } else {
        await businessEvalsRequest(`/api/projects/${encodeURIComponent(project.id)}`, projectResponseSchema, { workspaceId, method: "DELETE" })
        window.location.assign("/projects")
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The project could not be archived."); setSaving(false) }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button variant={project ? "outline" : "default"} className="rounded-md border-slate-200">{project ? "Edit project" : "New project"}</Button>} /><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{project ? "Edit project" : "Create project"}</DialogTitle><DialogDescription>Projects can represent your own product, a client site or a personal build.</DialogDescription></DialogHeader><form onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="project-name">Name</FieldLabel><Input id="project-name" name="name" defaultValue={project?.name} required /></Field><Field><FieldLabel htmlFor="project-website">Public HTTPS website</FieldLabel><Input id="project-website" name="website" type="url" defaultValue={project?.website} placeholder="https://example.com" required /></Field><div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="project-kind">Project kind</FieldLabel><NativeSelect id="project-kind" name="kind" defaultValue={project?.kind ?? "client_site"}><NativeSelectOption value="own_product">Own product</NativeSelectOption><NativeSelectOption value="client_site">Client site</NativeSelectOption><NativeSelectOption value="personal">Personal</NativeSelectOption></NativeSelect></Field><Field><FieldLabel htmlFor="project-recipient">Report recipient</FieldLabel><Input id="project-recipient" name="recipient" type="email" defaultValue={project?.reportRecipientEmail} /></Field></div><Field><FieldLabel htmlFor="project-notes">Notes</FieldLabel><Textarea id="project-notes" name="notes" defaultValue={project?.notes} rows={3} /></Field>{error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}<DialogFooter className="justify-between"><div>{project ? <Button type="button" variant="destructive" onClick={archive} disabled={saving}>Archive</Button> : null}</div><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save project"}</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog>
}

function ProjectAuthorization({ project, newJourneyHref }: { project: ReturnType<typeof useEvals>["projects"][number]; newJourneyHref: string }) {
  const { workspaceId, previewMode, authorizeProject } = useEvals()
  const router = useRouter()
  const current = project.authorization
  const [attested, setAttested] = useState(false)
  const [approvedActionDomains, setApprovedActionDomains] = useState(() => current?.approvedActionDomains.filter((domain) => domain !== project.domain).join("\n") ?? "")
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  async function authorize() {
    if (!attested) return
    setSaving(true); setMessage("")
    try {
      const domains = parseApprovedActionDomains(approvedActionDomains)
      if (previewMode) await authorizeProject(project.id, domains)
      else await businessEvalsRequest(`/api/projects/${encodeURIComponent(project.id)}/authorization`, projectAuthorizationResponseSchema, { workspaceId, method: "POST", body: JSON.stringify({ projectId: project.id, domain: project.domain, attestationVersion: "2026-07-18", attested: true, approvedActionDomains: domains }) })
      if (current?.state === "current") {
        if (previewMode) router.refresh()
        else window.location.reload()
      } else if (previewMode) router.push(newJourneyHref)
      else window.location.assign(newJourneyHref)
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Authorization could not be recorded.") } finally { setSaving(false) }
  }
  return (
    <Card id="project-authorization" className="mb-6 scroll-mt-24 rounded-lg border border-slate-200 bg-white shadow-none ring-0">
      <CardHeader>
        <CardTitle>Owner authorization</CardTitle>
        <CardDescription>Required before Maintain Flow scans or submits marked synthetic data to this public site.</CardDescription>
      </CardHeader>
      <CardContent>
        {current ? (
          <section aria-labelledby="current-authorization-heading" className="mb-6 border-b border-slate-200 pb-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="current-authorization-heading" className="text-sm font-semibold text-slate-950">Latest immutable attestation</h3>
              <span className={`text-xs font-semibold ${current.state === "current" ? "text-emerald-700" : "text-red-700"}`}>
                {current.state === "current" ? "Current" : "Revoked"}
              </span>
            </div>
            <dl className="mt-4 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <AuthorizationFact label="Domain" value={current.domain} />
              <AuthorizationFact label="Approved action domains" value={current.approvedActionDomains.join(", ") || current.domain} />
              <AuthorizationFact label="Attestation version" value={current.attestationVersion} />
              <AuthorizationFact label="Authorized by" value={`${current.actor.name}${current.actor.email ? ` · ${current.actor.email}` : ""}`} />
              <AuthorizationFact label="Recorded" value={current.recordedAt} />
              <AuthorizationFact label="Revocation" value={current.revokedAt ?? "Not revoked"} />
            </dl>
          </section>
        ) : <p className="mb-6 border-b border-slate-200 pb-6 text-sm text-slate-600">No authorization attestation has been recorded for this project.</p>}
        <Field>
          <FieldLabel htmlFor="approved-action-domains">Explicitly approved action domains</FieldLabel>
          <Textarea id="approved-action-domains" value={approvedActionDomains} onChange={(event) => setApprovedActionDomains(event.target.value)} rows={3} placeholder={`verify.${project.domain}\napi.${project.domain}`} />
          <p className="mt-1 text-xs leading-5 text-slate-500">Optional, one hostname per line or comma. Add only public domains that may receive an approved redirect, verification link, form action or cleanup webhook. The primary domain <strong>{project.domain}</strong> is always included.</p>
        </Field>
        <label className="mt-4 flex items-start gap-3 text-sm leading-6 text-slate-700">
          <Checkbox checked={attested} onCheckedChange={(value) => setAttested(value === true)} className="mt-1" />
          <span>I confirm that I own this project or have the owner’s permission to evaluate <strong>{project.domain}</strong> and every action domain listed above.</span>
        </label>
        <Button onClick={authorize} disabled={!attested || saving} className="mt-4 rounded-md bg-blue-600 hover:bg-blue-700">{saving ? "Recording…" : current ? "Record replacement authorization" : "Record authorization"}</Button>
        {current?.state === "current" ? <p className="mt-2 text-xs leading-5 text-slate-500">A replacement creates a new immutable attestation, revokes the current one and pauses affected journeys until reviewed.</p> : null}
        <p aria-live="polite" className="mt-3 text-sm text-slate-500">{message}</p>
      </CardContent>
    </Card>
  )
}

function AuthorizationFact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words font-medium text-slate-900">{value}</dd></div>
}

function parseApprovedActionDomains(value: string) {
  const domains = [...new Set(value.split(/[\n,]/).map((item) => item.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean))]
  if (domains.length > 20) throw new Error("Authorize no more than 20 additional action domains.")
  for (const domain of domains) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      throw new Error(`${domain} is not a valid public hostname.`)
    }
  }
  return domains
}

function signupJourneyTemplate(value: string | null) {
  return value === "lead_form" || value === "trial_signup" ? value : null
}

function projectHealthStatus(health: ReturnType<typeof useEvals>["projects"][number]["health"], journeys: ReturnType<typeof useEvals>["journeys"]) {
  if (health === "healthy") return "passed"
  if (health === "degraded" || health === "failed") return health
  if (journeys.some((journey) => journey.status === "failed")) return "failed"
  if (journeys.some((journey) => journey.status === "degraded")) return "degraded"
  if (journeys.some((journey) => journey.status === "passed")) return "passed"
  return "inconclusive"
}

function projectHealthLabel(health: ReturnType<typeof useEvals>["projects"][number]["health"], journeys: ReturnType<typeof useEvals>["journeys"]) {
  const status = projectHealthStatus(health, journeys)
  return status === "passed" ? "Healthy" : status === "inconclusive" ? "Pending" : status[0].toUpperCase() + status.slice(1)
}
