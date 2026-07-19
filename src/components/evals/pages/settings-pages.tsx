"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useQuery } from "@tanstack/react-query"
import { businessEvalsRequest, createIdempotencyKey } from "@/lib/api/business-evals-client"
import {
  alertEndpointDeletionResponseSchema,
  alertEndpointMutationResponseSchema,
  alertSettingsResponseSchema,
  billingSettingsResponseSchema,
  teamInvitationResponseSchema,
  teamMemberRemovalResponseSchema,
  teamMemberUpdateResponseSchema,
  teamSettingsResponseSchema,
  workspaceSettingsResponseSchema,
} from "@/lib/api/business-evals-response-schemas"
import {
  annualBillingDiscountPercent,
  billingPlans,
  billingPriceDisplay,
  readCheckoutBillingSelection,
  type BillingInterval,
  type CheckoutBillingPlanId,
} from "@/lib/billing/plans"
import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"
import { IconBell, IconCreditCard, IconSettings, IconTrash, IconUsers } from "@tabler/icons-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useState, type FormEvent, type ReactNode } from "react"
import { type ZodType, z } from "zod"
import { useEvals } from "../evals-provider"
import { EvalPage, PageHeading } from "../page-primitives"

const settingsNav = [
  { label: "Workspace", href: "/settings/workspace", icon: IconSettings },
  { label: "Team", href: "/settings/team", icon: IconUsers },
  { label: "Alerts", href: "/settings/alerts", icon: IconBell },
  { label: "Billing", href: "/settings/billing", icon: IconCreditCard },
] as const

export function SettingsPage({ section }: { section: "workspace" | "team" | "alerts" | "billing" }) {
  return (
    <EvalPage>
      <PageHeading title="Settings" description="Manage the workspace boundary, team and operational notifications." />
      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
          {settingsNav.map((item) => {
            const Icon = item.icon
            const active = item.href.endsWith(section)
            return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100"}`}><Icon className="size-4" />{item.label}</Link>
          })}
        </nav>
        {section === "workspace" ? <WorkspaceSettings /> : null}
        {section === "team" ? <TeamSettings /> : null}
        {section === "alerts" ? <AlertSettings /> : null}
        {section === "billing" ? <BillingSettings /> : null}
      </div>
    </EvalPage>
  )
}

function WorkspaceSettings() {
  const { data, loading, error, reload, workspaceId, previewMode } = useSettingsResource("/api/settings/workspace", workspaceSettingsResponseSchema)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!data) return
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setMessage("")
    try {
      if (previewMode) {
        setMessage("Preview only: workspace changes are not persisted.")
        return
      }
      await businessEvalsRequest("/api/settings/workspace", workspaceSettingsResponseSchema, {
        workspaceId,
        method: "PATCH",
        body: JSON.stringify({
          expectedUpdatedAt: data.updatedAt,
          name: String(form.get("name") ?? ""),
          reportSenderName: String(form.get("reportSenderName") ?? ""),
          reportSenderEmail: String(form.get("reportSenderEmail") ?? ""),
          primaryColor: String(form.get("primaryColor") ?? "").trim() || null,
        }),
      })
      setMessage("Workspace settings saved.")
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Workspace settings could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  return <SettingsCard title="Workspace profile" description="The shared identity shown across projects and reports."><SettingsState loading={loading} error={error}>{data ? <form key={data.updatedAt} onSubmit={save}><FieldGroup><Field><FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel><Input id="workspace-name" name="name" defaultValue={data.name} required /></Field><div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="report-sender-name">Report sender name</FieldLabel><Input id="report-sender-name" name="reportSenderName" defaultValue={data.reportSenderName} placeholder={data.name} /></Field><Field><FieldLabel htmlFor="report-sender-email">Report sender email</FieldLabel><Input id="report-sender-email" name="reportSenderEmail" type="email" defaultValue={data.reportSenderEmail} /><FieldDescription>Leave blank to use the verified workspace default.</FieldDescription></Field></div><Field><FieldLabel htmlFor="workspace-colour">Primary report colour</FieldLabel><Input id="workspace-colour" name="primaryColor" defaultValue={data.primaryColor ?? ""} placeholder="#2563eb" pattern="#[0-9a-fA-F]{6}" /></Field><Button type="submit" disabled={saving} className="w-fit rounded-md bg-blue-600 hover:bg-blue-700">{saving ? "Saving…" : "Save workspace"}</Button><Feedback message={message} /></FieldGroup></form> : null}</SettingsState></SettingsCard>
}

function TeamSettings() {
  const { data, loading, error, reload, workspaceId, previewMode } = useSettingsResource("/api/settings/team", teamSettingsResponseSchema)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setMessage("")
    try {
      if (previewMode) {
        event.currentTarget.reset()
        setMessage("Preview only: invitations are not sent.")
        return
      }
      await businessEvalsRequest("/api/settings/team", teamInvitationResponseSchema, { workspaceId, method: "POST", body: JSON.stringify({ email: String(form.get("email") ?? ""), role: String(form.get("role") ?? "member") }) })
      event.currentTarget.reset()
      setMessage("The workspace invitation was created.")
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The invitation could not be created.")
    } finally {
      setSaving(false)
    }
  }

  async function changeMember(userId: string, operation: "role" | "remove", role?: "admin" | "member") {
    setSaving(true)
    setMessage("")
    try {
      if (previewMode) {
        setMessage(operation === "remove" ? "Preview only: the member was not removed." : "Preview only: member roles are not changed.")
        return
      }
      await businessEvalsRequest(`/api/settings/team/${encodeURIComponent(userId)}`, operation === "remove" ? teamMemberRemovalResponseSchema : teamMemberUpdateResponseSchema, { workspaceId, method: operation === "remove" ? "DELETE" : "PATCH", body: operation === "role" ? JSON.stringify({ role }) : undefined })
      setMessage(operation === "remove" ? "Member removed." : "Member role updated.")
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The team could not be updated.")
    } finally {
      setSaving(false)
    }
  }

  return <SettingsCard title="Team" description="People who can configure journeys and respond to incidents."><SettingsState loading={loading} error={error}>{data ? <><p className="mb-3 text-xs text-slate-500">{data.usage.seatsUsed} of {data.usage.seatLimit ?? "unlimited"} {data.usage.plan} seats used</p><div className="flex flex-col divide-y divide-slate-200">{data.members.map((member) => <div key={member.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">{initials(member.name || member.email)}</span><span className="min-w-0 flex-1"><span className="block font-medium text-slate-900">{member.name}</span><span className="block truncate text-xs text-slate-500">{member.email}</span></span>{member.role === "owner" ? <span className="text-sm capitalize text-slate-600">Owner</span> : <><NativeSelect aria-label={`Role for ${member.name}`} value={member.role} disabled={saving} onChange={(event) => changeMember(member.userId, "role", event.target.value as "admin" | "member")} className="w-32"><NativeSelectOption value="admin">Admin</NativeSelectOption><NativeSelectOption value="member">Member</NativeSelectOption></NativeSelect><Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${member.name}`} disabled={saving} onClick={() => changeMember(member.userId, "remove")}><IconTrash className="size-4" /></Button></>}</div>)}</div><form onSubmit={invite} className="mt-5 grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-[1fr_130px_auto] sm:items-end"><Field><FieldLabel htmlFor="invite-email">Invite by email</FieldLabel><Input id="invite-email" name="email" type="email" required /></Field><Field><FieldLabel htmlFor="invite-role">Role</FieldLabel><NativeSelect id="invite-role" name="role" defaultValue="member"><NativeSelectOption value="member">Member</NativeSelectOption><NativeSelectOption value="admin">Admin</NativeSelectOption></NativeSelect></Field><Button type="submit" disabled={saving} className="rounded-md bg-blue-600 hover:bg-blue-700">Invite</Button></form><Feedback message={message} /></> : null}</SettingsState></SettingsCard>
}

function AlertSettings() {
  const { data, loading, error, reload, workspaceId, previewMode } = useSettingsResource("/api/settings/alerts", alertSettingsResponseSchema)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  async function createEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setSaving(true)
    setMessage("")
    try {
      if (previewMode) {
        event.currentTarget.reset()
        setMessage("Preview only: alert destinations are not persisted.")
        return
      }
      const result = await businessEvalsRequest("/api/settings/alerts", alertEndpointMutationResponseSchema, { workspaceId, method: "POST", body: JSON.stringify({ kind: String(form.get("kind") ?? "email"), name: String(form.get("name") ?? ""), destination: String(form.get("destination") ?? ""), enabled: true }) })
      event.currentTarget.reset()
      setMessage(result.data.signingSecret ? `Destination created. Copy this webhook signing secret now; it will not be shown again: ${result.data.signingSecret}` : "Alert destination created.")
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The alert destination could not be created.")
    } finally {
      setSaving(false)
    }
  }

  async function updateEndpoint(id: string, operation: "toggle" | "delete", enabled?: boolean) {
    setSaving(true)
    setMessage("")
    try {
      if (previewMode) {
        setMessage(operation === "delete" ? "Preview only: the alert destination was not removed." : "Preview only: alert destinations are not changed.")
        return
      }
      await businessEvalsRequest(`/api/settings/alerts/${encodeURIComponent(id)}`, operation === "delete" ? alertEndpointDeletionResponseSchema : alertEndpointMutationResponseSchema, { workspaceId, method: operation === "delete" ? "DELETE" : "PATCH", body: operation === "toggle" ? JSON.stringify({ enabled }) : undefined })
      setMessage(operation === "delete" ? "Alert destination removed or safely disabled to preserve delivery history." : "Alert destination updated.")
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The alert destination could not be updated.")
    } finally {
      setSaving(false)
    }
  }

  return <SettingsCard title="Operational alerts" description="Notify the team when a journey fails, degrades or recovers."><SettingsState loading={loading} error={error}>{data ? <><p className="mb-4 text-xs text-slate-500">{data.entitlement.plan} · email {data.entitlement.email ? "enabled" : "unavailable"} · webhook {data.entitlement.webhook ? "enabled" : "unavailable"}</p><div className="flex flex-col divide-y divide-slate-200">{data.endpoints.map((endpoint) => <div key={endpoint.id} className="flex items-center gap-3 py-4"><span className="min-w-0 flex-1"><span className="block font-medium text-slate-900">{endpoint.name}</span><span className="block truncate text-xs text-slate-500">{endpoint.kind} · {endpoint.destinationPreview}</span></span><Switch aria-label={`${endpoint.enabled ? "Disable" : "Enable"} ${endpoint.name}`} checked={endpoint.enabled} disabled={saving} onCheckedChange={(checked) => updateEndpoint(endpoint.id, "toggle", checked)} /><Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${endpoint.name}`} disabled={saving} onClick={() => updateEndpoint(endpoint.id, "delete")}><IconTrash className="size-4" /></Button></div>)}{!data.endpoints.length ? <p className="py-5 text-sm text-slate-500">No alert destinations yet.</p> : null}</div><form onSubmit={createEndpoint} className="mt-5 grid gap-3 rounded-lg border border-slate-200 p-4"><div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="alert-kind">Destination type</FieldLabel><NativeSelect id="alert-kind" name="kind" defaultValue="email"><NativeSelectOption value="email">Email</NativeSelectOption><NativeSelectOption value="webhook">Webhook</NativeSelectOption></NativeSelect></Field><Field><FieldLabel htmlFor="alert-name">Display name</FieldLabel><Input id="alert-name" name="name" required placeholder="Operations" /></Field></div><Field><FieldLabel htmlFor="alert-destination">Email address or HTTPS webhook URL</FieldLabel><Input id="alert-destination" name="destination" required /></Field><Button type="submit" disabled={saving} className="w-fit rounded-md bg-blue-600 hover:bg-blue-700">Add destination</Button></form><Feedback message={message} /></> : null}</SettingsState></SettingsCard>
}

function BillingSettings() {
  const { data, loading, error, workspaceId, previewMode } = useSettingsResource("/api/settings/billing", billingSettingsResponseSchema)
  const searchParams = useSearchParams()
  const searchKey = searchParams.toString()
  const requestedSelection = readCheckoutBillingSelection(searchParams)
  const [opening, setOpening] = useState(false)
  const [checkoutPlan, setCheckoutPlan] = useState<CheckoutBillingPlanId | "">("")
  const [selection, setSelection] = useState(() => ({ searchKey, ...requestedSelection }))
  const [message, setMessage] = useState("")
  const selectedPlan = selection.searchKey === searchKey ? selection.plan : requestedSelection.plan
  const interval = selection.searchKey === searchKey ? selection.interval : requestedSelection.interval

  function chooseInterval(nextInterval: BillingInterval) {
    setSelection({ searchKey, plan: selectedPlan, interval: nextInterval })
  }

  async function openPortal() {
    setOpening(true)
    setMessage("")
    try {
      if (previewMode) {
        setMessage("Preview only: connect Stripe before opening the billing portal.")
        setOpening(false)
        return
      }
      const token = await getValidSupabaseAccessToken()
      if (!token) throw new Error("Sign in before opening billing.")
      const response = await fetch("/api/billing/portal", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-MaintainFlow-Workspace-Id": workspaceId }, body: JSON.stringify({ flow: "manage" }) })
      const payload = await response.json().catch(() => ({})) as { url?: string; error?: string }
      if (!response.ok || !payload.url) throw new Error(payload.error || "Billing could not be opened.")
      window.location.assign(payload.url)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Billing could not be opened.")
      setOpening(false)
    }
  }

  async function openCheckout(plan: CheckoutBillingPlanId) {
    setSelection({ searchKey, plan, interval })
    setCheckoutPlan(plan)
    setMessage("")
    try {
      if (previewMode) {
        setMessage(`Preview only: ${billingPlans[plan].name} checkout will open after Stripe is connected.`)
        setCheckoutPlan("")
        return
      }
      const token = await getValidSupabaseAccessToken()
      if (!token) throw new Error("Sign in before choosing a plan.")
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-MaintainFlow-Workspace-Id": workspaceId,
          "Idempotency-Key": createIdempotencyKey(`billing-checkout:${plan}:${interval}`),
        },
        body: JSON.stringify({ plan, interval }),
      })
      const payload = await response.json().catch(() => ({})) as { url?: string; error?: string }
      if (!response.ok || !payload.url) throw new Error(payload.error || "Checkout could not be opened.")
      window.location.assign(payload.url)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Checkout could not be opened.")
      setCheckoutPlan("")
    }
  }

  const checkoutPlans = [billingPlans.starter, billingPlans.growth, billingPlans.scale] as const
  const selectedPlanDetails = selectedPlan ? billingPlans[selectedPlan] : null
  const selectedPlanDisplay = selectedPlanDetails ? billingPriceDisplay(selectedPlanDetails, interval) : null
  return <SettingsCard title="Plan and usage" description="Business eval capacity for this workspace."><SettingsState loading={loading} error={error}>{data ? <><div className="mb-5 flex flex-col gap-2 rounded-lg bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"><span><span className="block text-xs text-slate-500">Current plan</span><span className="mt-1 block text-xl font-semibold text-slate-950">{data.plan.name}</span></span><span className="text-sm capitalize text-slate-600">{data.trial.active && data.trial.endsAt ? `Trial ends ${new Date(data.trial.endsAt).toLocaleDateString("en-IE")}` : data.plan.state}</span></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Usage label="Projects" used={data.usage.projects.used} limit={data.usage.projects.limit} /><Usage label="Journeys" used={data.usage.journeys.used} limit={data.usage.journeys.limit} /><Usage label="Monthly runs" used={data.usage.runs.used} limit={data.usage.runs.limit} /><Usage label="Seats" used={data.usage.seats.used} limit={data.usage.seats.limit} /></div><p className="mt-4 text-sm text-slate-600">Evidence retention: {data.usage.evidenceRetentionDays} days.</p>{data.subscription.portalAvailable ? <Button type="button" onClick={openPortal} disabled={opening} className="mt-5 rounded-md bg-blue-600 hover:bg-blue-700">{opening ? "Opening…" : "Manage billing"}</Button> : null}{selectedPlanDetails && selectedPlanDisplay ? <div role="status" className="mt-7 rounded-lg border border-blue-200 bg-blue-50 p-4"><span className="text-xs font-semibold uppercase tracking-wide text-blue-700">Selected from pricing</span><p className="mt-1 text-base font-semibold text-slate-950">{selectedPlanDetails.name} · {interval === "annual" ? "Annual" : "Monthly"}</p><p className="mt-1 text-sm text-slate-600">{selectedPlanDisplay.amount} {selectedPlanDisplay.suffix}. {selectedPlanDisplay.note}</p><p className="mt-2 text-xs text-blue-800">Review the plan below. Stripe checkout opens only after you choose the plan button.</p></div> : null}<div className="mt-8 flex flex-col gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-end sm:justify-between"><span><span className="block text-lg font-semibold text-slate-950">Choose a paid plan</span><span className="mt-1 block text-sm text-slate-500">Solo, Team and Agency include email proof, live report links and PDF exports.</span></span><Field className="sm:w-48"><FieldLabel htmlFor="billing-interval">Billing interval</FieldLabel><NativeSelect id="billing-interval" value={interval} onChange={(event) => chooseInterval(event.target.value as BillingInterval)}><NativeSelectOption value="monthly">Monthly</NativeSelectOption><NativeSelectOption value="annual">Annual · save {annualBillingDiscountPercent}%</NativeSelectOption></NativeSelect></Field></div><div className="mt-4 grid gap-3 xl:grid-cols-3">{checkoutPlans.map((plan) => {
        const display = billingPriceDisplay(plan, interval)
        const current = data.plan.id === plan.id
        const selected = selectedPlan === plan.id
        return <div key={plan.id} className={`flex flex-col rounded-lg border p-4 ${selected ? "border-blue-600 bg-blue-50/60 ring-2 ring-blue-100" : current ? "border-blue-300 bg-blue-50/30" : "border-slate-200"}`}><div className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-950">{plan.name}</span><span className="flex flex-wrap justify-end gap-1">{selected ? <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">Selected</span> : null}{current ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Current</span> : null}</span></div><p className="mt-2 text-2xl font-semibold text-slate-950">{display.amount}<span className="ml-1 text-xs font-normal text-slate-500">{display.suffix}</span></p><p className="mt-2 min-h-12 text-xs leading-5 text-slate-500">{plan.description}</p><p className="mt-3 text-xs text-slate-600">{plan.businessEvalLimits.projects} projects · {plan.businessEvalLimits.journeys} journeys · {plan.businessEvalLimits.seats} seats</p><Button type="button" variant={selected || plan.id === "growth" ? "default" : "outline"} onClick={() => openCheckout(plan.id as CheckoutBillingPlanId)} disabled={Boolean(checkoutPlan) || data.subscription.portalAvailable} className={`mt-4 w-full rounded-md ${selected || plan.id === "growth" ? "bg-blue-600 hover:bg-blue-700" : "border-slate-200"}`}>{checkoutPlan === plan.id ? "Opening checkout…" : selected ? `Continue with ${plan.name}` : `Choose ${plan.name}`}</Button><p className="mt-2 min-h-10 text-xs leading-5 text-slate-500">{data.subscription.portalAvailable ? "Use Manage billing to change an existing subscription." : display.note}</p></div>
      })}</div>{!data.subscription.portalAvailable && data.subscription.portalUnavailableReason ? <p className="mt-3 text-xs text-slate-500">{data.subscription.portalUnavailableReason}</p> : null}<Feedback message={message} /></> : null}</SettingsState></SettingsCard>
}

function useSettingsResource<TSchema extends ZodType>(path: string, schema: TSchema) {
  const { workspaceId, previewMode } = useEvals()
  const resourceWorkspaceId = workspaceId || (previewMode ? previewSettingsWorkspaceId : "pending")
  const query = useQuery({
    queryKey: ["business-evals", resourceWorkspaceId, "settings", path],
    enabled: !previewMode && Boolean(workspaceId),
    queryFn: () => businessEvalsRequest(path, schema, { workspaceId }),
    staleTime: 15_000,
  })
  const previewData = previewMode ? schema.parse(previewSettingsFixture(path)) : null
  return {
    data: (previewData ?? query.data?.data ?? null) as z.infer<TSchema> | null,
    loading: previewMode ? false : query.isPending,
    error: previewMode ? "" : query.error instanceof Error ? query.error.message : query.error ? "Settings could not be loaded." : "",
    workspaceId,
    previewMode,
    reload: previewMode ? async () => undefined : () => query.refetch(),
  }
}

const previewSettingsWorkspaceId = "00000000-0000-4000-8000-000000000999"

function previewSettingsFixture(path: string): unknown {
  if (path === "/api/settings/workspace") {
    return {
      id: previewSettingsWorkspaceId,
      name: "Maintain Flow Demo",
      slug: "maintain-flow-demo",
      logoUrl: "",
      primaryColor: "#2563eb",
      reportSenderName: "Maintain Flow Evals",
      reportSenderEmail: "reports@maintainflow.test",
      plan: "Team",
      updatedAt: "2026-07-18T10:45:00.000Z",
    }
  }
  if (path === "/api/settings/team") {
    return {
      members: [
        { id: "preview-member-owner", userId: "preview-user-owner", role: "owner", name: "Lena Moore", email: "lena@beacon.example", avatarUrl: "", joinedAt: "2026-07-01T09:00:00.000Z" },
        { id: "preview-member-operator", userId: "preview-user-operator", role: "member", name: "Mina Park", email: "mina@northstar.example", avatarUrl: "", joinedAt: "2026-07-03T11:30:00.000Z" },
      ],
      usage: { seatsUsed: 2, seatLimit: 5, plan: "Team" },
    }
  }
  if (path === "/api/settings/alerts") {
    return {
      endpoints: [
        { id: "preview-alert-email", name: "Journey owners", kind: "email", destinationPreview: "l•••@beacon.example", enabled: true, createdAt: "2026-07-01T09:30:00.000Z", updatedAt: "2026-07-18T10:45:00.000Z" },
        { id: "preview-alert-webhook", name: "Operations webhook", kind: "webhook", destinationPreview: "https://ops.beacon.example/••••", enabled: true, createdAt: "2026-07-02T14:00:00.000Z", updatedAt: "2026-07-18T10:45:00.000Z" },
      ],
      deliveries: [
        { id: "preview-delivery-1", endpointId: "preview-alert-email", evalRunId: "run-1014", incidentId: "inc-verification-delay", eventType: "incident.opened", status: "delivered", attemptCount: 1, nextAttemptAt: null, deliveredAt: "2026-07-18T10:43:00.000Z", lastError: "", createdAt: "2026-07-18T10:42:45.000Z", updatedAt: "2026-07-18T10:43:00.000Z" },
      ],
      entitlement: { email: true, webhook: true, state: "trialing", plan: "Team" },
    }
  }
  if (path === "/api/settings/billing") {
    return {
      plan: { id: "growth", publicKey: "team", name: "Team", state: "trialing", grandfathered: false, annualDiscountPercent: annualBillingDiscountPercent },
      usage: {
        projects: { used: 3, limit: 15 },
        journeys: { used: 3, limit: 30 },
        runs: { used: 142, limit: 7_500 },
        seats: { used: 2, limit: 5 },
        evidenceRetentionDays: 90,
      },
      features: { email: true, webhook: true, liveLink: true, pdf: true, whiteLabel: false },
      trial: { startedAt: "2026-07-12T09:00:00.000Z", endsAt: "2026-07-26T09:00:00.000Z", usedAt: "2026-07-12T09:00:00.000Z", active: true },
      subscription: { status: "trialing", portalAvailable: false, portalUnavailableReason: "The billing portal becomes available after a paid subscription starts." },
    }
  }
  throw new Error(`No preview settings fixture exists for ${path}.`)
}

function SettingsCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}

function SettingsState({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Spinner className="size-4" />Loading settings</div>
  if (error) return <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
  return children
}

function Feedback({ message }: { message: string }) {
  return <p aria-live="polite" className="mt-3 min-h-5 break-words text-xs text-slate-500">{message}</p>
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  return <div className="rounded-md border border-slate-200 p-4"><span className="text-xs text-slate-500">{label}</span><span className="mt-1 block text-xl font-semibold text-slate-950">{used} / {limit ?? "∞"}</span></div>
}

function initials(value: string) {
  return value.split(/\s|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "MF"
}
