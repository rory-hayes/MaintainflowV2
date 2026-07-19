import "server-only"

import { buildPublicAcquisitionMetrics, parseContentRangeCount } from "@/lib/ops/health-utils"
import type {
  OpsHealthResponse,
  OpsHealthStatus,
  OpsRecentJob,
  OpsRecentProductEvent,
  OpsRecentRateLimitEvent,
  OpsRecentWorkflow,
} from "@/lib/ops/types"
import { getSupabaseServerConfig } from "@/lib/supabase/server"

type Row = Record<string, unknown>

const FUNNEL_STEPS = [
  ["sign_in_completed", "Signed in"],
  ["workspace_created", "Workspace created"],
  ["client_created", "Client added"],
  ["workflow_test_succeeded", "Endpoint tested"],
  ["workflow_created", "Workflow saved"],
  ["report_generated", "Report generated"],
  ["checkout_clicked", "Checkout clicked"],
] as const

export async function loadOpsHealth(input: { adminEmail: string }): Promise<OpsHealthResponse> {
  const generatedAt = new Date().toISOString()
  const now = new Date()
  const staleSince = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    users,
    agencies,
    memberships,
    clients,
    workflows,
    checks,
    checkRuns,
    reports,
    openIssues,
    unresolvedHighRiskIssues,
    pendingSetupChecks,
    overdueChecks,
    storedReportPdfs,
    productEventsLast7Days,
    publicAcquisitionEventsLast7Days,
    rateLimitEventsLast24Hours,
    blockedRateLimitEventsLast24Hours,
  ] = await Promise.all([
    safeCount("profiles"),
    safeCount("agencies"),
    safeCount("memberships"),
    safeCount("clients?archived_at=is.null"),
    safeCount("workflows?archived_at=is.null"),
    safeCount("checks"),
    safeCount("check_runs?evidence_origin=eq.service"),
    safeCount("reports"),
    safeCount("issues?status=in.(open,in_review,snoozed)"),
    safeCount("issues?status=in.(open,in_review,snoozed)&severity=in.(high,critical)"),
    safeCount("checks?pending_setup=eq.true"),
    safeCount(`checks?enabled=eq.true&pending_setup=eq.false&next_run_at=lte.${encodeURIComponent(generatedAt)}`),
    safeCount("reports?pdf_storage_path=not.is.null"),
    safeCount(`product_events?created_at=gte.${encodeURIComponent(since7d)}`),
    safeCount(`public_acquisition_events?created_at=gte.${encodeURIComponent(since7d)}`),
    safeCount(`rate_limit_events?created_at=gte.${encodeURIComponent(since24h)}`),
    safeCount(`rate_limit_events?created_at=gte.${encodeURIComponent(since24h)}&allowed=eq.false`),
  ])

  const [
    workflowRows,
    recentWorkflowRows,
    recentJobRows,
    productEventRows,
    publicAcquisitionRowsResult,
    recentProductEventRows,
    recentRateLimitRows,
  ] = await Promise.all([
    safeRows<Row>("workflows?select=status,last_check_run_at,archived_at&limit=5000"),
    safeRows<Row>("workflows?select=id,agency_id,client_id,name,status,report_included,last_check_run_at,created_at&order=created_at.desc&limit=8"),
    safeRows<Row>("check_job_runs?select=id,agency_id,status,checks_due,checks_run,failures,error_message,created_at&order=created_at.desc&limit=8"),
    safeRows<Row>(`product_events?select=event_name,route&created_at=gte.${encodeURIComponent(since7d)}&limit=1000`),
    safeRowsResult<Row>(`rpc/get_public_acquisition_metrics?p_since=${encodeURIComponent(since7d)}`),
    safeRows<Row>("product_events?select=id,agency_id,user_id,event_name,route,created_at&order=created_at.desc&limit=12"),
    safeRows<Row>("rate_limit_events?select=id,agency_id,user_id,scope,allowed,remaining,reset_at,created_at&order=created_at.desc&limit=12"),
  ])

  const workflowStatus = statusCounts(workflowRows)
  const staleWorkflows = workflowRows.filter((row) => {
    if (String(row.archived_at ?? "")) return false
    const status = String(row.status ?? "")
    if (status === "pending" || status === "archived") return false
    const lastRunAt = typeof row.last_check_run_at === "string" ? row.last_check_run_at : ""
    return !lastRunAt || lastRunAt < staleSince
  }).length
  const recentJobs = recentJobRows.map(jobRow)
  const lastJobAt = recentJobs[0]?.createdAt ?? null
  const productEventsInstalled = productEventsLast7Days.ok
  const publicAcquisitionEventsInstalled = publicAcquisitionEventsLast7Days.ok && publicAcquisitionRowsResult.ok
  const rateLimitEventsInstalled = rateLimitEventsLast24Hours.ok
  const topRoutes = topRouteCounts(productEventRows)
  const acquisition = buildPublicAcquisitionMetrics(publicAcquisitionRowsResult.rows)

  return {
    ok: true,
    generatedAt,
    adminEmail: input.adminEmail,
    providers: providerHealth({
      supabaseReady: users.ok && agencies.ok,
      stripePriceCount: stripePriceCount(),
      schedulerLastJobAt: lastJobAt,
      overdueChecks: value(overdueChecks),
      productEventsInstalled,
      productEventsLast7Days: value(productEventsLast7Days),
      rateLimitEventsInstalled,
      storedReportPdfs: value(storedReportPdfs),
    }),
    metrics: [
      { label: "Users", value: value(users), detail: "Supabase profile rows" },
      { label: "Agencies", value: value(agencies), detail: `${value(memberships)} memberships` },
      { label: "Clients", value: value(clients), detail: "Active client records" },
      { label: "Workflows", value: value(workflows), detail: `${value(checks)} checks configured` },
      { label: "Check runs", value: value(checkRuns), detail: "Service-issued monitoring evidence" },
      { label: "Reports", value: value(reports), detail: `${value(storedReportPdfs)} stored PDFs` },
      { label: "Open issues", value: value(openIssues), detail: `${value(unresolvedHighRiskIssues)} high-risk unresolved` },
      { label: "Analytics events", value: value(productEventsLast7Days), detail: "Last 7 days" },
    ],
    workflowStatus,
    risk: {
      pendingSetupChecks: value(pendingSetupChecks),
      overdueChecks: value(overdueChecks),
      staleWorkflows,
      openIssues: value(openIssues),
      unresolvedHighRiskIssues: value(unresolvedHighRiskIssues),
    },
    scheduler: {
      lastJobAt,
      recentJobs,
    },
    analytics: {
      eventsInstalled: productEventsInstalled,
      eventsLast7Days: value(productEventsLast7Days),
      funnel: funnel(productEventRows),
      topRoutes,
      recentEvents: recentProductEventRows.map(productEventRow),
    },
    acquisition: {
      eventsInstalled: publicAcquisitionEventsInstalled,
      metricsAvailable: publicAcquisitionRowsResult.ok,
      eventsLast7Days: value(publicAcquisitionEventsLast7Days),
      ...acquisition,
    },
    rateLimits: {
      eventsInstalled: rateLimitEventsInstalled,
      eventsLast24Hours: value(rateLimitEventsLast24Hours),
      blockedLast24Hours: value(blockedRateLimitEventsLast24Hours),
      recentEvents: recentRateLimitRows.map(rateLimitRow),
    },
    recentWorkflows: recentWorkflowRows.map(workflowRow),
  }
}

function providerHealth(input: {
  supabaseReady: boolean
  stripePriceCount: number
  schedulerLastJobAt: string | null
  overdueChecks: number
  productEventsInstalled: boolean
  productEventsLast7Days: number
  rateLimitEventsInstalled: boolean
  storedReportPdfs: number
}) {
  const stripeSecret = Boolean(process.env.STRIPE_SECRET_KEY)
  const stripeWebhook = Boolean(process.env.STRIPE_WEBHOOK_SECRET)
  const cronSecret = Boolean(process.env.CRON_SECRET)
  const supabasePublic = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const serviceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

  return [
    provider("Supabase", input.supabaseReady && serviceRole ? "healthy" : supabasePublic ? "attention" : "missing", input.supabaseReady ? "Service-role reads and Auth verification are responding." : "Set Supabase URL, anon key, and service role before launch.", serviceRole ? "Service role ready" : "Service role missing"),
    provider("Stripe", stripeSecret && stripeWebhook && input.stripePriceCount > 0 ? "healthy" : stripeSecret ? "attention" : "missing", `${input.stripePriceCount} price environment variables configured.`, stripeWebhook ? "Webhook configured" : "Webhook missing"),
    provider("Scheduler", cronSecret && input.schedulerLastJobAt ? "healthy" : cronSecret ? "attention" : "missing", input.schedulerLastJobAt ? `Last job ${formatRelativeTime(input.schedulerLastJobAt)}.` : "No stored scheduler job runs yet.", `${input.overdueChecks} checks overdue`),
    provider("Report storage", serviceRole ? "healthy" : "attention", "Private report downloads use the authorized API route.", `${input.storedReportPdfs} PDFs stored`),
    provider("Product analytics", input.productEventsInstalled ? "healthy" : "attention", input.productEventsInstalled ? "First-party funnel events table is available." : "Run the ops observability SQL to create product_events.", `${input.productEventsLast7Days} events / 7d`),
    provider("Rate limits", input.rateLimitEventsInstalled ? "healthy" : "attention", input.rateLimitEventsInstalled ? "Endpoint-test limiter events are persisted." : "Run the ops observability SQL to create rate_limit_events.", input.rateLimitEventsInstalled ? "Persistent ledger" : "Runtime-only"),
  ]
}

function provider(name: string, status: OpsHealthStatus, detail: string, metric: string) {
  return { name, status, detail, metric }
}

function stripePriceCount() {
  return [
    process.env.STRIPE_PRICE_STARTER,
    process.env.STRIPE_PRICE_GROWTH,
    process.env.STRIPE_PRICE_SCALE,
  ].filter(Boolean).length
}

type CountResult = { ok: true; count: number } | { ok: false; count: 0; error: string }

async function safeCount(path: string): Promise<CountResult> {
  try {
    return { ok: true, count: await countRows(path) }
  } catch (error) {
    return {
      ok: false,
      count: 0,
      error: error instanceof Error ? error.message : "Count query failed.",
    }
  }
}

async function countRows(path: string) {
  const response = await serviceFetch(withSelect(path, "id"), {
    headers: {
      Prefer: "count=exact",
      Range: "0-0",
    },
  })
  const count = parseContentRangeCount(response.headers.get("content-range"))
  if (count !== null) return count
  const rows = (await response.json().catch(() => [])) as unknown[]
  return Array.isArray(rows) ? rows.length : 0
}

async function safeRows<T>(path: string): Promise<T[]> {
  try {
    const response = await serviceFetch(path)
    const rows = (await response.json().catch(() => [])) as T[]
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

type RowsResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; rows: T[]; error: string }

async function safeRowsResult<T>(path: string): Promise<RowsResult<T>> {
  try {
    const response = await serviceFetch(path)
    const rows = (await response.json().catch(() => [])) as T[]
    return { ok: true, rows: Array.isArray(rows) ? rows : [] }
  } catch (error) {
    return {
      ok: false,
      rows: [],
      error: error instanceof Error ? error.message : "Rows query failed.",
    }
  }
}

async function serviceFetch(path: string, init: RequestInit = {}) {
  const config = getSupabaseServerConfig()
  const response = await fetch(`${config.restUrl}/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { message?: string; hint?: string }
    throw new Error(payload.message || payload.hint || "Supabase ops query failed.")
  }

  return response
}

function withSelect(path: string, select: string) {
  const joiner = path.includes("?") ? "&" : "?"
  return `${path}${joiner}select=${select}`
}

function value(result: CountResult) {
  return result.count
}

function statusCounts(rows: Row[]) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const status = String(row.status ?? "unknown")
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
}

function funnel(rows: Row[]) {
  let previous: number | null = null
  return FUNNEL_STEPS.map(([eventName, label]) => {
    const count = rows.filter((row) => row.event_name === eventName).length
    const dropoffFromPrevious = previous === null ? null : Math.max(0, previous - count)
    previous = count
    return { eventName, label, count, dropoffFromPrevious }
  })
}

function topRouteCounts(rows: Row[]) {
  const counts = rows.reduce<Record<string, number>>((next, row) => {
    const route = String(row.route ?? "").trim() || "unknown"
    next[route] = (next[route] ?? 0) + 1
    return next
  }, {})

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([route, count]) => ({ route, count }))
}

function workflowRow(row: Row): OpsRecentWorkflow {
  return {
    id: String(row.id ?? ""),
    agencyId: String(row.agency_id ?? ""),
    clientId: String(row.client_id ?? ""),
    name: String(row.name ?? ""),
    status: String(row.status ?? "pending"),
    reportIncluded: Boolean(row.report_included),
    lastCheckRunAt: typeof row.last_check_run_at === "string" ? row.last_check_run_at : null,
    createdAt: rowTime(row.created_at),
  }
}

function jobRow(row: Row): OpsRecentJob {
  return {
    id: String(row.id ?? ""),
    agencyId: String(row.agency_id ?? ""),
    status: String(row.status ?? "skipped"),
    checksDue: Number(row.checks_due ?? 0),
    checksRun: Number(row.checks_run ?? 0),
    failures: Number(row.failures ?? 0),
    errorMessage: String(row.error_message ?? ""),
    createdAt: rowTime(row.created_at),
  }
}

function productEventRow(row: Row): OpsRecentProductEvent {
  return {
    id: String(row.id ?? ""),
    agencyId: typeof row.agency_id === "string" ? row.agency_id : null,
    userId: typeof row.user_id === "string" ? row.user_id : null,
    eventName: String(row.event_name ?? ""),
    route: String(row.route ?? ""),
    createdAt: rowTime(row.created_at),
  }
}

function rateLimitRow(row: Row): OpsRecentRateLimitEvent {
  return {
    id: String(row.id ?? ""),
    agencyId: typeof row.agency_id === "string" ? row.agency_id : null,
    userId: typeof row.user_id === "string" ? row.user_id : null,
    scope: String(row.scope ?? ""),
    allowed: Boolean(row.allowed),
    remaining: Number(row.remaining ?? 0),
    resetAt: typeof row.reset_at === "string" ? row.reset_at : null,
    createdAt: rowTime(row.created_at),
  }
}

function rowTime(value: unknown) {
  return typeof value === "string" ? value : new Date(0).toISOString()
}

function formatRelativeTime(value: string) {
  const deltaMs = Date.now() - new Date(value).getTime()
  const minutes = Math.max(0, Math.round(deltaMs / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
