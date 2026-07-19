"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { useCoreLoopContext } from "@/components/app/core-loop-provider"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { ButtonLink } from "@/components/ui/button-link"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { getScreenSummary, type ScreenKey } from "@/data/maintainflow"
import { trackProductEvent } from "@/lib/analytics/product-events"
import { getEffectiveBillingPlan, resolveBillingEntitlement } from "@/lib/billing/entitlements"
import {
  annualBillingDiscountPercent,
  billingIntervals,
  billingLimitPercent,
  billingPlans,
  billingPriceDisplay,
  cardFreeWorkspaceTrialDays,
  formatBillingLimit,
  type BillingInterval,
  type BillingPlanId,
} from "@/lib/billing/plans"
import { parseCurlCommand } from "@/lib/core/curl"
import { buildHealthTrendData } from "@/lib/core/dashboard-metrics"
import { workflowAssuranceFromServiceRuns } from "@/lib/core/evidence-provenance"
import { detectPlatformImport, type PlatformImportResult } from "@/lib/core/imports"
import { currentMonthToDate, dateInputValue, validateReportPeriod } from "@/lib/core/report-period"
import { reportSnapshotUsesOnlyServiceEvidence } from "@/lib/core/report-state"
import { aggregateReportMetrics, reportGenerationEvidenceError } from "@/lib/core/reporting"
import { createReportViewModel } from "@/lib/core/reports/report-view-model"
import { savedAssertionsViolation, savedMonitorPolicyViolation } from "@/lib/core/saved-monitor-policy"
import type { UrlScanResult, UrlScanSuggestion } from "@/lib/core/url-scan"
import { cn } from "@/lib/utils"
import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"
import { downloadReportPdfFromApi } from "@/lib/supabase/report-storage"
import { useRouter, useSearchParams } from "next/navigation"
import { Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts"
import {
  validateWorkflowClientStep,
  validateWorkflowConfigureStep,
  workflowWizardInitialDraft,
  workflowWizardPlaceholders,
  type WorkflowWizardError,
  type WorkflowWizardField,
} from "@/lib/core/workflow-wizard"
import type {
  Client,
  Check,
  CheckRun,
  AssertionConfig,
  AssertionType,
  EndpointTestInput,
  EndpointTestResult,
  Issue,
  Report,
  Workflow,
  WorkflowMethod,
} from "@/lib/core/types"
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconChevronDown,
  IconCircleCheck,
  IconClock,
  IconCopy,
  IconCreditCard,
  IconDatabase,
  IconDownload,
  IconExternalLink,
  IconHeartbeat,
  IconPlayerPlay,
  IconPlus,
  IconReportAnalytics,
  IconTool,
  IconUsers,
} from "@tabler/icons-react"
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"

type MaintainFlowScreenProps = {
  screenKey: ScreenKey
  entityId?: string
}

const methodOptions: WorkflowMethod[] = ["GET"]

const frequencyOptions = [
  { label: "Hourly", value: 60 },
  { label: "Every 6 hours", value: 360 },
  { label: "Daily", value: 1440 },
]

const healthTrendChartConfig = {
  healthy: {
    label: "Healthy",
    color: "var(--chart-2)",
  },
  attention: {
    label: "Needs attention",
    color: "var(--destructive)",
  },
  skipped: {
    label: "Inconclusive",
    color: "var(--muted-foreground)",
  },
} satisfies ChartConfig

const workflowSetupMethods: Array<{
  id: WorkflowSetupMethod
  label: string
  description: string
  helper: string
  icon: typeof IconUsers
}> = [
  {
    id: "endpoint",
    label: "Endpoint",
    description: "Paste a public HTTPS GET health or heartbeat URL.",
    helper: "Best for APIs and automations that expose a credential-free health endpoint.",
    icon: IconHeartbeat,
  },
  {
    id: "curl",
    label: "cURL",
    description: "Paste a public GET cURL command and Maintain Flow fills the monitor.",
    helper: "Saved monitors cannot include authentication, query secrets, custom headers, or a request body.",
    icon: IconTool,
  },
  {
    id: "import",
    label: "Import",
    description: "Paste n8n, Make, or Zapier details to detect setup needs.",
    helper: "Creates a pending monitor when the workflow needs a production URL first.",
    icon: IconDatabase,
  },
]

type BillingStatus = {
  secretConfigured: boolean
  prices: Record<BillingPlanId, boolean>
  annualPrices: Record<BillingPlanId, boolean>
  checkoutConfigured: boolean
  portalConfigured: boolean
  workspaceTrialDays?: number
}

type BillingUsageSummary = {
  clients: number
  workflows: number
  reportsPerMonth: number
}

type BillingLimitNotice = {
  message: string
}

export function MaintainFlowScreen({ screenKey, entityId }: MaintainFlowScreenProps) {
  const { user } = useAuth()
  const [addIntent, setAddIntent] = useState<"client" | "workflow" | null>(null)
  const core = useCoreLoopContext()
  const screen = getScreenSummary(screenKey)
  const searchParams = useSearchParams()
  const searchParamString = searchParams.toString()
  const autoOpenAddClient = addIntent === "client"
  const autoOpenAddWorkflow = addIntent === "workflow"

  useEffect(() => {
    const intent = searchParams.get("add")
    setAddIntent(intent === "client" || intent === "workflow" ? intent : null)
  }, [screenKey, searchParamString, searchParams])

  if (!user) {
    return null
  }

  if (core.loading) {
    return (
      <div className="flex flex-col gap-5">
        <ScreenIntro title={screen.title} description="Loading your Maintain Flow workspace." />
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Loading workspace</CardTitle>
            <CardDescription>Fetching tenant-scoped clients, workflows, checks, issues, and reports.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (!core.agency) {
    return (
      <div className="flex flex-col gap-5">
        <ScreenIntro title={screen.title} description="Create your agency workspace to unlock the Maintain Flow core loop." />
        {core.syncError ? (
          <Card className="border-destructive/40 bg-muted/20">
            <CardHeader>
              <CardTitle>Workspace connection needs attention</CardTitle>
              <CardDescription>{core.syncError}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}
        <AgencySetupCard onCreate={core.createAgency} defaultName={user.company} />
      </div>
    )
  }

  const screenContent = (
    <>
      {screenKey === "overview" ? <OverviewScreen core={core} /> : null}
      {screenKey === "onboarding" ? <OnboardingScreen core={core} /> : null}
      {screenKey === "action-center" ? <ActionCenterScreen core={core} /> : null}
      {screenKey === "clients" ? <ClientsScreen core={core} autoOpenAddClient={autoOpenAddClient} /> : null}
      {screenKey === "client-detail" ? <ClientDetailScreen core={core} entityId={entityId} /> : null}
      {screenKey === "workflows" ? <WorkflowsScreen core={core} autoOpenAddWorkflow={autoOpenAddWorkflow} /> : null}
      {screenKey === "workflow-detail" ? <WorkflowDetailScreen core={core} entityId={entityId} /> : null}
      {screenKey === "checks" ? <ChecksScreen core={core} /> : null}
      {screenKey === "issues" ? <IssuesScreen core={core} /> : null}
      {screenKey === "issue-detail" ? <IssueDetailScreen core={core} entityId={entityId} /> : null}
      {screenKey === "reports" ? <ReportsScreen core={core} /> : null}
      {screenKey === "report-detail" ? <ReportDetailScreen core={core} entityId={entityId} /> : null}
      {screenKey === "settings" ? <SettingsScreen core={core} /> : null}
    </>
  )

  return (
    <div className="flex flex-col gap-5">
      {screenKey === "overview" ? <TodayStatusCard core={core} /> : null}
      {core.syncError ? (
        <Card className="border-destructive/40 bg-muted/20">
          <CardHeader>
            <CardTitle>Workspace sync needs attention</CardTitle>
            <CardDescription>{core.syncError}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {screenKey === "overview" ? <MetricsGrid core={core} /> : null}
      {screenContent}
    </div>
  )
}

type Core = ReturnType<typeof useCoreLoopContext>
type WorkflowWizardStep = "client" | "method" | "configure" | "test" | "save"
type WorkflowSetupMethod = "endpoint" | "curl" | "import"
type WorkflowRegistryFilter = "all" | "failed" | "due" | "report" | "pending"
type ActivationChecklistStep = {
  label: string
  done?: boolean
  href: string
  completeText: string
  pendingText: string
  actionLabel: string
}

const workflowRegistryFilters: Array<{ id: WorkflowRegistryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "due", label: "Due" },
  { id: "report", label: "Report-included" },
  { id: "pending", label: "Pending setup" },
]

const workflowStepDetails: Record<WorkflowWizardStep, { title: string; description: string }> = {
  client: {
    title: "Choose the client",
    description: "Attach the monitor to the client whose retained workflows you maintain. You can create the client inline.",
  },
  method: {
    title: "Pick the fastest setup path",
    description: "Use a public HTTPS GET URL, paste an equivalent cURL command, or import platform details when a health endpoint still needs work.",
  },
  configure: {
    title: "Define the monitor",
    description: "Name the workflow, set the endpoint, and adjust checks only when the default health check is not enough.",
  },
  test: {
    title: "Run the first check",
    description: "Validate the endpoint before saving so the first official run is real evidence, not placeholder data.",
  },
  save: {
    title: "Confirm the core loop",
    description: "The workflow, default check, first run, issues, and report eligibility are stored and reloaded.",
  },
}

function ScreenIntro({ title, description }: { title: string; description: string }) {
  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  )
}

function MetricsGrid({ core }: { core: Core }) {
  const data = core.data
  const clients = data?.clients.filter((client) => !client.archivedAt) ?? []
  const workflows = data?.workflows.filter((workflow) => !workflow.archivedAt) ?? []
  const openIssues = data?.issues.filter((issue) => !["resolved", "ignored"].includes(issue.status)) ?? []
  const healthyRuns = data?.checkRuns.filter((run) => run.status === "healthy").length ?? 0
  const runCount = data?.checkRuns.length ?? 0
  const passRate = runCount ? Math.round((healthyRuns / runCount) * 1000) / 10 : 0

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Active clients" value={String(clients.length)} detail={core.agency?.name ?? "Agency"} icon={IconUsers} />
      <MetricCard label="Monitored workflows" value={String(workflows.length)} detail="Report-included endpoint checks" icon={IconActivity} />
      <MetricCard label="Open issues" value={String(openIssues.length)} detail="Failed or degraded checks" icon={IconAlertTriangle} />
      <MetricCard label="Evidence pass rate" value={`${passRate}%`} detail={`${runCount} service-issued check runs`} icon={IconHeartbeat} />
    </section>
  )
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: string
  detail: string
  icon: typeof IconUsers
}) {
  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardAction>
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden />
          </span>
        </CardAction>
        <CardDescription>{detail}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-medium tracking-tight">{value}</p>
      </CardContent>
    </Card>
  )
}

function TodayStatusCard({ core }: { core: Core }) {
  const data = core.data
  const [now] = useState(() => Date.now())
  const workflows = data?.workflows.filter((workflow) => !workflow.archivedAt) ?? []
  const openIssues = data?.issues.filter((issue) => !["resolved", "ignored"].includes(issue.status)) ?? []
  const highPriorityIssues = openIssues.filter((issue) => ["high", "critical"].includes(issue.severity))
  const dueChecks = data?.checks.filter((check) => {
    if (!check.nextRunAt) return false
    return new Date(check.nextRunAt).getTime() <= now
  }) ?? []
  const readyReports = data?.reports.filter((report) => report.status === "ready").length ?? 0
  const latestReport = data?.reports[0]
  const latestReportClient = latestReport ? data?.clients.find((client) => client.id === latestReport.clientId) : null
  const nextAction = highPriorityIssues.length
    ? { label: "Review critical issues", href: "/action-center", detail: `${highPriorityIssues.length} high-priority item${highPriorityIssues.length === 1 ? "" : "s"} need owner attention.` }
    : dueChecks.length
      ? { label: "Run due checks", href: "/checks", detail: `${dueChecks.length} check${dueChecks.length === 1 ? "" : "s"} are ready to run now.` }
      : readyReports
        ? { label: "Send ready reports", href: "/reports", detail: `${readyReports} report${readyReports === 1 ? "" : "s"} can be reviewed or sent.` }
        : workflows.length
          ? { label: "Open action center", href: "/action-center", detail: "No critical blockers. Keep the daily review loop moving." }
          : { label: "Start workflow setup", href: "/onboarding", detail: "Add the first client workflow to begin monitoring." }

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Today&apos;s maintenance command center</CardTitle>
        <CardDescription>
          Prioritize failures, due checks, and report-ready proof across {core.agency?.name ?? "this workspace"}.
        </CardDescription>
        <CardAction>
          <ButtonLink href={nextAction.href} size="sm">
            {nextAction.label}
            <IconArrowRight data-icon="inline-end" />
          </ButtonLink>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label="Risks needing owner" value={highPriorityIssues.length || openIssues.length} />
        <SummaryTile label="Checks due now" value={dueChecks.length} />
        <SummaryTile label="Reports ready" value={readyReports} />
        <SummaryTile
          label="Latest proof"
          value={latestReportClient ? `${latestReportClient.name} ${latestReport?.status}` : "No report yet"}
        />
      </CardContent>
      <CardFooter className="border-t border-border pt-4">
        <p className="text-sm leading-6 text-muted-foreground">{nextAction.detail}</p>
      </CardFooter>
    </Card>
  )
}

function OverviewScreen({ core }: { core: Core }) {
  const checklist = core.checklist
  const steps: ActivationChecklistStep[] = [
    {
      label: "Add client",
      done: checklist?.clientCreated,
      href: "/clients",
      completeText: "A retained client is stored.",
      pendingText: "Add the first client whose workflows you maintain.",
      actionLabel: "Add client",
    },
    {
      label: "Add workflow",
      done: checklist?.workflowConnected,
      href: "/workflows",
      completeText: "A workflow monitor is connected.",
      pendingText: "Attach a public HTTPS GET health endpoint, equivalent cURL command, or platform import for that client.",
      actionLabel: "Add workflow",
    },
    {
      label: "Run check",
      done: checklist?.firstCheckRun,
      href: "/checks",
      completeText: "Check evidence is being stored.",
      pendingText: "Save or run a workflow check so evidence is stored.",
      actionLabel: "Open checks",
    },
    {
      label: "Preview report",
      done: checklist?.reportGenerated,
      href: "/reports",
      completeText: "Client-ready report proof exists.",
      pendingText: "Preview the first client report once check evidence is available.",
      actionLabel: "Preview report",
    },
  ]
  const complete = steps.filter((step) => step.done).length
  const activationComplete = complete === steps.length

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex flex-col gap-4">
        <HealthTrendCard core={core} />
        {!activationComplete ? (
          <ActivationChecklistCard steps={steps} complete={complete} />
        ) : null}
      </div>
      <RecentActivityCard core={core} />
    </section>
  )
}

function HealthTrendCard({ core }: { core: Core }) {
  const storedRuns = core.data?.checkRuns
  const runs = storedRuns ?? []
  const trendData = useMemo(() => buildHealthTrendData(storedRuns ?? []), [storedRuns])
  const runAxisMax = Math.max(3, ...trendData.map((point) => point.total))
  const attentionRuns = runs.filter((run) => run.status === "failed" || run.status === "degraded").length
  const healthyRuns = runs.filter((run) => run.status === "healthy").length
  const conclusiveRuns = runs.filter((run) => run.status !== "skipped").length
  const passRate = conclusiveRuns ? Math.round((healthyRuns / conclusiveRuns) * 1000) / 10 : 0
  const latencyRuns = runs.filter((run) => typeof run.latencyMs === "number")
  const avgLatency = latencyRuns.length
    ? Math.round(latencyRuns.reduce((total, run) => total + (run.latencyMs ?? 0), 0) / latencyRuns.length)
    : null

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Workflow health command center</CardTitle>
        <CardDescription>Last 14 days of stored check run outcomes across monitored workflows.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {runs.length ? (
          <>
            <ChartContainer config={healthTrendChartConfig} className="h-56 w-full">
              <ComposedChart data={trendData} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={18}
                />
                <YAxis
                  yAxisId="runs"
                  domain={[0, runAxisMax]}
                  allowDecimals={false}
                  hide
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar yAxisId="runs" dataKey="attention" stackId="runs" fill="var(--color-attention)" radius={3} />
                <Bar yAxisId="runs" dataKey="skipped" stackId="runs" fill="var(--color-skipped)" radius={3} />
                <Bar yAxisId="runs" dataKey="healthy" stackId="runs" fill="var(--color-healthy)" radius={3} />
              </ComposedChart>
            </ChartContainer>
            <div className="grid gap-3 md:grid-cols-4">
              <SummaryTile label="Check runs" value={runs.length} />
              <SummaryTile label="Pass rate" value={`${passRate}%`} />
              <SummaryTile label="Historical failures" value={attentionRuns} />
              <SummaryTile label="Avg latency" value={avgLatency === null ? "n/a" : `${avgLatency}ms`} />
            </div>
            <ButtonLink href="/checks" variant="outline" size="sm" className="w-full sm:w-fit sm:self-end">
              Open checks
            </ButtonLink>
          </>
        ) : (
          <NotFoundEmpty
            title="No check runs yet"
            description="Add a workflow and run its first check to populate the command center."
          />
        )}
      </CardContent>
    </Card>
  )
}

function ActivationChecklistCard({
  steps,
  complete,
}: {
  steps: ActivationChecklistStep[]
  complete: number
}) {
  const progress = steps.length ? Math.round((complete / steps.length) * 100) : 0

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Activation checklist</CardTitle>
        <CardDescription>
          Complete the first maintenance loop so the dashboard can shift from setup guidance to live workflow command center.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{complete} of {steps.length} steps complete</span>
            <span>{progress}%</span>
          </div>
          <Progress value={progress} aria-label={`${complete} of ${steps.length} activation steps complete`} />
        </div>
        <div className="flex flex-col gap-2">
          {steps.map((step) => (
            <div key={step.label} className="flex items-center gap-3 rounded-lg border border-border bg-background/45 p-3">
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                {step.done ? <IconCircleCheck aria-hidden /> : <IconClock aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{step.label}</p>
                <p className="text-xs text-muted-foreground">{step.done ? step.completeText : step.pendingText}</p>
              </div>
              <ButtonLink href={step.href} variant={step.done ? "ghost" : "outline"} size="sm">
                {step.done ? "Open" : step.actionLabel}
              </ButtonLink>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function OnboardingScreen({ core }: { core: Core }) {
  const checklist = core.checklist
  const steps = [
    {
      label: "Add client",
      detail: "The retained client whose automations you maintain.",
      done: Boolean(checklist?.clientCreated),
      action: <AddClientDialog core={core} triggerLabel="Add client" />,
    },
    {
      label: "Add workflow",
      detail: "A public HTTPS GET health endpoint or imported automation with a structural default check.",
      done: Boolean(checklist?.workflowConnected),
      action: <AddWorkflowDialog core={core} triggerLabel="Start workflow setup" />,
    },
    {
      label: "Run check",
      detail: "A stored test result that proves the workflow is monitored.",
      done: Boolean(checklist?.firstCheckRun),
      action: <ButtonLink href="/checks" variant="outline">Open checks</ButtonLink>,
    },
    {
      label: "Preview report",
      detail: "Selected-client evidence packaged into the first report preview.",
      done: Boolean(checklist?.reportGenerated),
      action: <ButtonLink href="/reports" variant="outline">Preview report</ButtonLink>,
    },
  ]
  const complete = steps.filter((step) => step.done).length
  const nextStep = steps.find((step) => !step.done) ?? steps.at(-1)
  const nextStepIndex = Math.max(0, steps.findIndex((step) => !step.done))
  const workflowSetupStarted = Boolean(checklist?.workflowConnected)

  return (
    <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>Launch the maintenance loop</CardTitle>
          <CardDescription>
            Add a client workflow, run the first check, and preview the first client-ready report.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Progress value={(complete / steps.length) * 100} />
          <div className="rounded-lg border border-border bg-background/60 p-4">
            <p className="text-sm text-muted-foreground">Next best action</p>
            <p className="mt-1 text-lg font-medium">{nextStep?.label ?? "Core loop complete"}</p>
            <p className="mt-1 text-sm text-muted-foreground">{nextStep?.detail}</p>
            <div className="mt-4">
              {!workflowSetupStarted ? (
                <AddWorkflowDialog core={core} triggerLabel="Start guided workflow setup" />
              ) : nextStep?.action ?? <ButtonLink href="/dashboard">Open dashboard</ButtonLink>}
            </div>
            {!workflowSetupStarted ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                This opens one modal that creates the client, saves the workflow, runs the first check, and makes the evidence available for reports.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>Core-loop checklist</CardTitle>
          <CardDescription>{core.agency?.name} is the workspace for this agency’s clients, checks, issues, and reports.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <div key={step.label} className="flex items-start gap-3 rounded-lg border border-border bg-background/45 p-3">
              <span className={cn(
                "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                step.done ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
              )}>
                {step.done ? <IconCircleCheck aria-hidden className="size-3.5" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{step.label}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.detail}</p>
              </div>
              <Badge variant={step.done ? "secondary" : index === nextStepIndex ? "default" : "outline"}>
                {step.done ? "Done" : index === nextStepIndex ? "Next" : "Queued"}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  )
}

function ClientsScreen({
  core,
  autoOpenAddClient = false,
}: {
  core: Core
  autoOpenAddClient?: boolean
}) {
  return <ClientsTable core={core} autoOpenAddClient={autoOpenAddClient} />
}

function ClientDetailScreen({ core, entityId }: { core: Core; entityId?: string }) {
  const client = findClient(core, entityId)
  const clientNameId = useId()
  const recipientEmailId = useId()
  const clientNotesId = useId()
  const [clientName, setClientName] = useState(client?.name ?? "")
  const [recipientEmail, setRecipientEmail] = useState(client?.reportRecipientEmail ?? "")
  const [clientNotes, setClientNotes] = useState(client?.notes ?? "")

  if (!client) return <NotFoundEmpty title="Client not found" description="This client does not exist in the current agency." />

  const workflows = core.data?.workflows.filter((workflow) => workflow.clientId === client.id) ?? []
  const issues = core.data?.issues.filter((issue) => issue.clientId === client.id) ?? []
  const reports = core.data?.reports.filter((report) => report.clientId === client.id) ?? []

  return (
    <section className="grid gap-4 xl:grid-cols-[1fr_24rem]">
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>{client.name}</CardTitle>
          <CardDescription>{client.reportRecipientEmail || "No report recipient yet"}</CardDescription>
          <CardAction>
            <Badge variant={issues.some((issue) => issue.status === "open") ? "destructive" : "secondary"}>
              {issues.filter((issue) => issue.status === "open").length} open issues
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <SummaryTile label="Workflows" value={workflows.length} />
          <SummaryTile label="Reports" value={reports.length} />
          <SummaryTile label="Last activity" value={formatDate(workflows[0]?.updatedAt ?? client.updatedAt)} />
          <div className="md:col-span-3 grid gap-3 lg:grid-cols-3">
            <LinkedList title="Workflows" items={workflows.map((workflow) => ({
              label: workflow.name,
              detail: workflow.status,
              href: `/workflows/${workflow.id}`,
            }))} />
            <LinkedList title="Issues" items={issues.map((issue) => ({
              label: issue.title,
              detail: issue.status,
              href: `/issues/${issue.id}`,
            }))} />
            <LinkedList title="Reports" items={reports.map((report) => ({
              label: `${report.periodStart} to ${report.periodEnd}`,
              detail: reportDisplayStatus(report),
              href: `/reports/${report.id}`,
            }))} />
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Edit client</CardTitle>
            <CardDescription>Update client profile and report recipient details.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={clientNameId}>Client name</FieldLabel>
                <Input id={clientNameId} value={clientName} onChange={(event) => setClientName(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor={recipientEmailId}>Report recipient</FieldLabel>
                <Input id={recipientEmailId} value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor={clientNotesId}>Notes</FieldLabel>
                <Textarea id={clientNotesId} value={clientNotes} onChange={(event) => setClientNotes(event.target.value)} rows={3} />
              </Field>
              <Button type="button" onClick={() => core.updateClient(client.id, { name: clientName, reportRecipientEmail: recipientEmail, notes: clientNotes })}>
                Save client
              </Button>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Add workflow</CardTitle>
            <CardDescription>Connect a new monitor for this client without leaving the client operations view.</CardDescription>
          </CardHeader>
          <CardFooter>
            <AddWorkflowDialog core={core} fixedClientId={client.id} triggerLabel="Add workflow" />
          </CardFooter>
        </Card>
      </div>
    </section>
  )
}

function WorkflowsScreen({
  core,
  autoOpenAddWorkflow = false,
}: {
  core: Core
  autoOpenAddWorkflow?: boolean
}) {
  return <WorkflowsTable core={core} autoOpenAddWorkflow={autoOpenAddWorkflow} />
}

function WorkflowDetailScreen({ core, entityId }: { core: Core; entityId?: string }) {
  const workflow = findWorkflow(core, entityId)
  if (!workflow) return <NotFoundEmpty title="Workflow not found" description="This workflow does not exist in the current agency." />
  const runs = core.data?.checkRuns.filter((run) => run.workflowId === workflow.id) ?? []
  const checks = workflowChecksForWorkflow(core, workflow)
  const activeChecks = checks.filter((check) => check.enabled && !check.pendingSetup)
  const issues = core.data?.issues.filter((issue) => issue.workflowId === workflow.id) ?? []

  return (
    <section className="grid gap-4 xl:grid-cols-[1fr_24rem]">
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>{workflow.name}</CardTitle>
          <CardDescription className="break-all">{workflow.method} {workflow.endpointUrl}</CardDescription>
          <CardAction>
            <RunCheckButton core={core} workflow={workflow} />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-4">
            <SummaryTile label="Health" value={`${workflow.healthScore}%`} />
            <SummaryTile label="Status" value={workflowStatusLabel(workflow)} />
            <SummaryTile label="Frequency" value={`${workflow.frequencyMinutes}m`} />
            <SummaryTile label="Report" value={workflow.reportIncluded ? "Included" : "Excluded"} />
          </div>
          <WorkflowCheckStates checks={activeChecks} runs={runs} />
          <RunHistoryTable runs={runs} />
        </CardContent>
      </Card>
      <IssueListCard core={core} issues={issues} />
    </section>
  )
}

function WorkflowCheckStates({ checks, runs }: { checks: Check[]; runs: CheckRun[] }) {
  const assurance = workflowAssuranceFromServiceRuns(checks, runs)
  const stateByCheck = new Map(assurance.checkStates.map((state) => [state.checkId, state]))

  return (
    <Card className="border-border bg-background/45">
      <CardHeader>
        <CardTitle>Active check states</CardTitle>
        <CardDescription>Every enabled check contributes to the workflow&apos;s aggregate state.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {checks.length ? checks.map((check) => {
          const state = stateByCheck.get(check.id)
          const latestAttempt = state?.latestRun
          const latestConclusive = state?.latestConclusiveRun
          const latestAttemptWasInconclusive = latestAttempt?.status === "skipped"
          return (
            <div key={check.id} className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{check.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {latestAttempt
                      ? `Latest attempt ${formatDate(latestAttempt.completedAt)}`
                      : "No service-issued run yet"}
                  </p>
                </div>
                <Badge variant={statusVariant(state?.status ?? "pending")}>
                  {assuranceStatusLabel(state?.status ?? "pending")}
                </Badge>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {latestAttemptWasInconclusive && latestConclusive && state?.status !== "pending"
                  ? `Latest attempt was inconclusive. Current state remains ${state?.status} from the latest conclusive run.`
                  : latestAttemptWasInconclusive
                    ? "Latest attempt was inconclusive, so this check is pending fresh conclusive evidence."
                    : latestConclusive
                      ? `Latest conclusive result: ${checkStatusLabel(latestConclusive.status)}.`
                      : "Run this check to establish its current state."}
              </p>
            </div>
          )
        }) : (
          <p className="rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
            No enabled checks are ready to run. Complete check setup first.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function ChecksScreen({ core }: { core: Core }) {
  const runs = core.data?.checkRuns ?? []
  const checks = core.data?.checks ?? []
  const jobRuns = core.data?.checkJobRuns ?? []
  const [runningDue, setRunningDue] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const dueCount = checks.filter((check) => check.enabled && !check.pendingSetup && check.nextRunAt && new Date(check.nextRunAt).getTime() <= nowMs).length
  const failedOrDegradedRuns = runs.filter((run) => run.status === "failed" || run.status === "degraded").length
  const pendingSetupCount = checks.filter((check) => check.pendingSetup).length
  const latestJob = jobRuns[0]
  const runDueDisabled = runningDue || dueCount === 0

  async function runDueChecks() {
    if (dueCount === 0) return
    setRunningDue(true)
    try {
      await core.runDueChecks()
      setNowMs(Date.now())
    } finally {
      setRunningDue(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>Check operations</CardTitle>
          <CardDescription>Keep monitoring evidence current before reports go to clients.</CardDescription>
          <CardAction>
            <Button type="button" variant="outline" onClick={runDueChecks} disabled={runDueDisabled}>
              <IconPlayerPlay data-icon="inline-start" />
              {runningDue ? "Running..." : `Run due (${dueCount})`}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <SummaryTile label="Due now" value={dueCount} />
          <SummaryTile label="Failed/degraded runs" value={failedOrDegradedRuns} />
          <SummaryTile label="Pending setup" value={pendingSetupCount} />
          <SummaryTile label="Latest scheduler job" value={latestJob?.status ?? "n/a"} />
        </CardContent>
      </Card>
      <section className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <RunHistoryTable runs={runs} title="All check run history" />
        <div className="flex flex-col gap-4">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Enabled checks</CardTitle>
            <CardDescription>Default health checks are created automatically when workflows are saved.</CardDescription>
            <CardAction>
              <Button type="button" variant="outline" onClick={runDueChecks} disabled={runDueDisabled}>
                <IconPlayerPlay data-icon="inline-start" />
                {runningDue ? "Running..." : `Run due (${dueCount})`}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {checks.length ? checks.map((check) => {
              const workflow = core.data?.workflows.find((item) => item.id === check.workflowId)
              const isDue = check.enabled && !check.pendingSetup && check.nextRunAt && new Date(check.nextRunAt).getTime() <= nowMs
              return (
                <div key={check.id} className="rounded-lg border border-border bg-background/45 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">{check.name}</p>
                    <Badge variant={check.pendingSetup ? "outline" : isDue ? "destructive" : "secondary"}>
                      {check.pendingSetup ? "Pending" : isDue ? "Due" : "Scheduled"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{workflow?.name} · every {check.scheduleMinutes} minutes</p>
                  <p className="mt-1 text-xs text-muted-foreground">Next run: {check.nextRunAt ? formatDate(check.nextRunAt) : "not scheduled"}</p>
                </div>
              )
            }) : <NotFoundEmpty title="No checks yet" description="Save a workflow to create the default health check." />}
          </CardContent>
        </Card>
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Scheduled job log</CardTitle>
            <CardDescription>Scheduled-check runs and failures are stored from the production runner.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {jobRuns.length ? jobRuns.slice(0, 6).map((job) => (
              <div key={job.id} className="rounded-lg border border-border bg-background/45 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{job.checksRun}/{job.checksDue} checks run</p>
                  <Badge variant={job.status === "success" ? "secondary" : job.status === "skipped" ? "outline" : "destructive"}>{job.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDate(job.completedAt)} · {job.failures} failure{job.failures === 1 ? "" : "s"}
                </p>
                {job.errorMessage ? <p className="mt-1 text-xs text-muted-foreground">{job.errorMessage}</p> : null}
              </div>
            )) : (
              <p className="rounded-lg border border-border bg-background/45 p-3 text-sm leading-6 text-muted-foreground">
                No scheduled jobs have run yet. The next due check run will create the first scheduler log entry.
              </p>
            )}
          </CardContent>
        </Card>
        </div>
      </section>
    </div>
  )
}

function IssuesScreen({ core }: { core: Core }) {
  return <IssueListCard core={core} issues={core.data?.issues ?? []} full />
}

function IssueDetailScreen({ core, entityId }: { core: Core; entityId?: string }) {
  const issue = findIssue(core, entityId)
  if (!issue) return <NotFoundEmpty title="Issue not found" description="This issue does not exist in the current agency." />
  return <IssueDetailCard core={core} issue={issue} />
}

function ReportsScreen({ core }: { core: Core }) {
  const hasReports = Boolean(core.data?.reports.length)
  const reportIncludedWorkflows = core.data?.workflows.filter((workflow) => workflow.reportIncluded && !workflow.archivedAt).length ?? 0
  const storedRuns = core.data?.checkRuns.length ?? 0
  const unresolvedReportableIssues = core.data?.issues.filter((issue) => issue.reportable && !["resolved", "ignored"].includes(issue.status)).length ?? 0
  return (
    <section className="grid gap-4 xl:grid-cols-[1fr_24rem]">
      <div className="flex flex-col gap-4">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Client-ready reporting</CardTitle>
            <CardDescription>
              Turn monitored workflows, check runs, detected issues, and resolutions into proof your agency can send.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-4">
            <SummaryTile label="Reports" value={core.data?.reports.length ?? 0} />
            <SummaryTile label="Ready" value={core.data?.reports.filter((report) => report.status === "ready").length ?? 0} />
            <SummaryTile label="Evidence items" value={core.data?.reportItems.length ?? 0} />
            <SummaryTile label="Clients covered" value={new Set(core.data?.reports.map((report) => report.clientId)).size} />
          </CardContent>
          <CardFooter className="grid gap-3 border-t border-border pt-4 md:grid-cols-3">
            <ReportReadinessPill
              label="Report-included workflows"
              value={reportIncludedWorkflows}
              ready={reportIncludedWorkflows > 0}
              href="/workflows"
            />
            <ReportReadinessPill
              label="Stored check runs"
              value={storedRuns}
              ready={storedRuns > 0}
              href="/checks"
            />
            <ReportReadinessPill
              label="Unresolved reportable issues"
              value={unresolvedReportableIssues}
              ready={unresolvedReportableIssues === 0}
              href="/issues"
            />
          </CardFooter>
        </Card>
        <ReportsTable core={core} />
      </div>
      <ReportGenerateCard core={core} compact={hasReports} />
    </section>
  )
}

function ReportReadinessPill({
  label,
  value,
  ready,
  href,
}: {
  label: string
  value: string | number
  ready: boolean
  href: string
}) {
  return (
    <ButtonLink
      href={href}
      variant="outline"
      className="h-auto min-h-24 flex-col items-start justify-between gap-3 rounded-lg px-3 py-3 text-left"
    >
      <span className="w-full min-w-0">
        <span className="block text-wrap text-xs leading-5 text-muted-foreground">{label}</span>
        <span className="mt-2 flex w-full items-center justify-between gap-3">
          <span className="text-sm font-medium">{value}</span>
          <Badge variant={ready ? "secondary" : "outline"} className="shrink-0">
            {ready ? "Ready" : "Review"}
          </Badge>
        </span>
      </span>
    </ButtonLink>
  )
}

function ReportDetailScreen({ core, entityId }: { core: Core; entityId?: string }) {
  const report = findReport(core, entityId)
  if (!report) return <NotFoundEmpty title="Report not found" description="This report does not exist in the current agency." />
  return <ReportPreviewCard core={core} report={report} />
}

function SettingsScreen({ core }: { core: Core }) {
  const searchParams = useSearchParams()
  const reloadWorkspace = core.reloadWorkspace
  const [name, setName] = useState(core.agency?.name ?? "")
  const [slug, setSlug] = useState(core.agency?.slug ?? "")
  const [senderName, setSenderName] = useState(core.agency?.reportSenderName ?? "")
  const [senderEmail, setSenderEmail] = useState(core.agency?.reportSenderEmail ?? "")
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null)
  const [savingAgencyProfile, setSavingAgencyProfile] = useState(false)
  const [savingReportDefaults, setSavingReportDefaults] = useState(false)
  const [profileMessage, setProfileMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null)
  const [reportDefaultsMessage, setReportDefaultsMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null)
  const [billingMessage, setBillingMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null)
  const [openingBilling, setOpeningBilling] = useState("")
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("monthly")
  const requestedSettingsTab = searchParams.get("tab")
  const billingReturn = searchParams.get("billing")
  const defaultSettingsTab = ["profile", "reports", "billing", "team"].includes(requestedSettingsTab ?? "")
    ? requestedSettingsTab ?? "profile"
    : "profile"
  const currentPlan = core.agency ? getEffectiveBillingPlan(core.agency) : billingPlans.free
  const billingEntitlement = core.agency ? resolveBillingEntitlement(core.agency) : null
  const currentPlanPrice = billingPriceDisplay(currentPlan, billingInterval)
  const recommendedUpgradePlanId = recommendedBillingUpgrade(currentPlan.id)
  const recommendedUpgradePlan = billingPlans[recommendedUpgradePlanId]
  const recommendedUpgradePrice = billingPriceDisplay(recommendedUpgradePlan, billingInterval)
  const annualCheckoutAvailable = Boolean(billingStatus?.annualPrices[recommendedUpgradePlanId])
  const workspaceTrialDays = billingStatus?.workspaceTrialDays ?? cardFreeWorkspaceTrialDays
  const trialInfo = getTrialInfo(core.agency?.trialEndsAt)
  const memberships = core.data?.memberships ?? []
  const usage = billingUsageForCore(core)
  const existingSubscriptionNeedsPortal = Boolean(
    core.agency?.stripeSubscriptionId
    && core.agency.stripeSubscriptionStatus !== "canceled"
    && core.agency.stripeSubscriptionStatus !== "incomplete_expired"
  )
  const highestSelfServePlan = currentPlan.id === "scale" || currentPlan.id === "agency_plus"
  const upgradeCheckoutAvailable = !existingSubscriptionNeedsPortal
    && !highestSelfServePlan
    && recommendedUpgradePlan.checkoutEligible
    && canCheckoutPlan(recommendedUpgradePlanId)
  const portalAvailable = Boolean(billingStatus?.portalConfigured && core.agency?.stripeCustomerId)
  const subscriptionUpdateAvailable = Boolean(portalAvailable && existingSubscriptionNeedsPortal)
  const upgradeReason = billingStatus
    ? existingSubscriptionNeedsPortal
      ? "Use Stripe Customer Portal to manage the existing subscription before starting another checkout."
      : highestSelfServePlan || !recommendedUpgradePlan.checkoutEligible
      ? "This workspace is already on the highest self-serve plan."
      : !billingStatus.checkoutConfigured || !billingStatus.prices[recommendedUpgradePlanId]
        ? "Stripe checkout is temporarily unavailable. You can keep using the current plan."
        : ""
    : "Checking Stripe configuration."
  const portalReason = billingStatus
    ? !billingStatus.portalConfigured
      ? "Stripe customer portal is temporarily unavailable."
      : portalAvailable
        ? "Stripe Customer Portal opens without a call or manual request."
        : "The customer portal opens after checkout creates and syncs a Stripe customer for this workspace."
    : "Checking Stripe configuration."

  useEffect(() => {
    const workspaceId = core.agency?.id
    if (!workspaceId) return
    let cancelled = false
    const controller = new AbortController()

    getValidSupabaseAccessToken()
      .then((accessToken) => {
        if (!accessToken) throw new Error("Sign in before checking billing.")
        return fetch("/api/billing/status", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-MaintainFlow-Workspace-Id": workspaceId,
          },
          signal: controller.signal,
        })
      })
      .then((response) => {
        if (!response.ok) throw new Error("Billing status is unavailable.")
        return response.json()
      })
      .then((status: BillingStatus | null) => {
        if (!cancelled) setBillingStatus(status)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        if (!cancelled) {
          setBillingStatus({
            secretConfigured: false,
            prices: { free: false, starter: false, growth: false, scale: false, agency_plus: false },
            annualPrices: { free: false, starter: false, growth: false, scale: false, agency_plus: false },
            checkoutConfigured: false,
            portalConfigured: false,
            workspaceTrialDays: cardFreeWorkspaceTrialDays,
          })
        }
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [core.agency?.id])

  useEffect(() => {
    if (!annualCheckoutAvailable && billingInterval === "annual") setBillingInterval("monthly")
  }, [annualCheckoutAvailable, billingInterval])

  useEffect(() => {
    if (billingReturn === "checkout-cancelled") {
      setBillingMessage({ tone: "error", text: "Checkout was cancelled before the plan changed." })
      return
    }

    if (billingReturn !== "checkout-success" && billingReturn !== "portal-return") return

    let cancelled = false
    let successfulRefresh = false
    const returnMessage = billingReturn === "checkout-success"
      ? "Checkout completed. Finished checking for Stripe's latest billing status."
      : "Returned from Stripe customer portal. Finished checking for Stripe's latest billing status."

    setBillingMessage({ tone: "success", text: "Refreshing the latest Stripe billing status..." })
    const refreshWorkspace = async (finalAttempt: boolean) => {
      try {
        await reloadWorkspace()
        successfulRefresh = true
        if (finalAttempt && !cancelled) {
          setBillingMessage({ tone: "success", text: returnMessage })
        }
      } catch (error) {
        if (finalAttempt && !cancelled) {
          setBillingMessage(successfulRefresh
            ? { tone: "success", text: returnMessage }
            : {
                tone: "error",
                text: error instanceof Error ? error.message : "Billing status could not be refreshed.",
              })
        }
      }
    }

    void refreshWorkspace(false)
    const retryIds = [1_500, 3_000, 5_000].map((delay, index, delays) => window.setTimeout(() => {
      void refreshWorkspace(index === delays.length - 1)
    }, delay))

    return () => {
      cancelled = true
      retryIds.forEach((retryId) => window.clearTimeout(retryId))
    }
  }, [billingReturn, reloadWorkspace])

  function canCheckoutPlan(planId: BillingPlanId) {
    return Boolean(
      billingStatus?.checkoutConfigured
      && billingStatus.prices[planId]
      && billingPlans[planId].checkoutEligible
    )
  }

  async function saveAgencyProfile() {
    setSavingAgencyProfile(true)
    setProfileMessage(null)
    try {
      await core.saveAgency({ name, slug })
      setProfileMessage({ tone: "success", text: "Agency profile saved." })
    } catch (error) {
      setProfileMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not save the agency profile.",
      })
    } finally {
      setSavingAgencyProfile(false)
    }
  }

  async function saveReportDefaults() {
    setSavingReportDefaults(true)
    setReportDefaultsMessage(null)
    try {
      await core.saveAgency({ reportSenderName: senderName, reportSenderEmail: senderEmail })
      setReportDefaultsMessage({ tone: "success", text: "Report defaults saved." })
    } catch (error) {
      setReportDefaultsMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Could not save report defaults.",
      })
    } finally {
      setSavingReportDefaults(false)
    }
  }

  async function openCheckout(planId: BillingPlanId) {
    trackProductEvent({
      eventName: "checkout_clicked",
      agencyId: core.agency?.id,
      metadata: { planId, billingInterval },
    })
    await openBillingSession("checkout", "/api/billing/checkout", { plan: planId, interval: billingInterval })
  }

  async function openPortal(flow: "manage" | "subscription_update" = "manage") {
    const action = flow === "subscription_update" ? "portal-update" : "portal"
    await openBillingSession(action, "/api/billing/portal", { flow })
  }

  async function openBillingSession(action: string, path: string, body: Record<string, string> = {}) {
    const token = await getValidSupabaseAccessToken()
    if (!token) {
      setBillingMessage({ tone: "error", text: "Sign in again before opening Stripe billing." })
      return
    }
    if (!core.agency?.id) {
      setBillingMessage({ tone: "error", text: "Select a workspace before opening Stripe billing." })
      return
    }

    setOpeningBilling(action)
    setBillingMessage(null)
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-MaintainFlow-Workspace-Id": core.agency.id,
        },
        body: JSON.stringify(body),
      })
      const payload = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "Stripe did not return a hosted billing URL.")
      }
      window.location.assign(payload.url)
    } catch (error) {
      setBillingMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Stripe billing could not be opened.",
      })
    } finally {
      setOpeningBilling("")
    }
  }

  return (
    <Tabs defaultValue={defaultSettingsTab} className="gap-4">
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>Workspace settings</CardTitle>
          <CardDescription>Manage agency identity, report defaults, billing, and launch team access from one place.</CardDescription>
          <CardAction>
            <Badge variant="secondary">{currentPlan.name}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <TabsList variant="line" className="min-w-max justify-start">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="reports">Report defaults</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
          </TabsList>
        </CardContent>
      </Card>

      <TabsContent value="profile">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Agency profile</CardTitle>
            <CardDescription>This is the workspace identity shown inside Maintain Flow.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>Agency name</FieldLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} />
                <FieldDescription>Use the agency name your team and clients recognize.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Slug</FieldLabel>
                <Input value={slug} onChange={(event) => setSlug(event.target.value)} />
                <FieldDescription>Used for workspace-safe records and future client-facing links.</FieldDescription>
              </Field>
              <Button type="button" onClick={saveAgencyProfile} disabled={savingAgencyProfile}>
                {savingAgencyProfile ? "Saving..." : "Save agency profile"}
              </Button>
              {profileMessage ? (
                <FieldDescription className={profileMessage.tone === "error" ? "text-destructive" : ""}>
                  {profileMessage.text}
                </FieldDescription>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="reports">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Report defaults</CardTitle>
            <CardDescription>Set the sender identity used on client-ready proof reports.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>Report sender name</FieldLabel>
                <Input value={senderName} onChange={(event) => setSenderName(event.target.value)} />
                <FieldDescription>Shown in generated report metadata and client delivery context.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Report sender email</FieldLabel>
                <Input type="email" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} />
                <FieldDescription>Use a monitored inbox clients can reply to.</FieldDescription>
              </Field>
              <Button type="button" onClick={saveReportDefaults} disabled={savingReportDefaults}>
                {savingReportDefaults ? "Saving..." : "Save report defaults"}
              </Button>
              {reportDefaultsMessage ? (
                <FieldDescription className={reportDefaultsMessage.tone === "error" ? "text-destructive" : ""}>
                  {reportDefaultsMessage.text}
                </FieldDescription>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="billing">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Billing</CardTitle>
            <CardDescription>Current plan, remaining usage, and self-serve Stripe controls for this workspace.</CardDescription>
            <CardAction>
              <Badge variant="secondary">{currentPlan.name}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.75fr)]">
              <div className="rounded-lg border border-border bg-background/60 p-4">
                <div>
                  <p className="text-sm text-muted-foreground">Current package</p>
                  <p className="mt-1 text-2xl font-medium">{currentPlan.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {currentPlanPrice.amount}{currentPlanPrice.suffix}
                  </p>
                  {trialInfo ? (
                    <Badge variant="secondary" className="mt-3">
                      Trial ends {trialInfo.endsLabel}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{currentPlan.description}</p>
                {billingEntitlement ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {billingEntitlement.label}: {billingEntitlement.description}
                  </p>
                ) : null}
                {currentPlan.checkoutEligible ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {trialInfo
                      ? `${trialInfo.daysLeftLabel} left in the paid plan trial. Manage cancellation or payment details in Stripe Customer Portal.`
                      : "Manage billing, cancellation, and payment details in Stripe Customer Portal."}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    One card-free {workspaceTrialDays}-day Team trial is available per workspace. Stripe checkout does not restart it.
                  </p>
                )}
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  {existingSubscriptionNeedsPortal ? (
                    <Button
                      type="button"
                      onClick={() => openPortal("subscription_update")}
                      disabled={!subscriptionUpdateAvailable || !!openingBilling}
                    >
                      <IconCreditCard data-icon="inline-start" />
                      {openingBilling === "portal-update" ? "Opening plan options..." : "Change plan in Stripe"}
                      <IconExternalLink data-icon="inline-end" />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      onClick={() => openCheckout(recommendedUpgradePlanId)}
                      disabled={!upgradeCheckoutAvailable || !!openingBilling}
                    >
                      <IconCreditCard data-icon="inline-start" />
                      {openingBilling === "checkout" ? "Opening checkout..." : `Upgrade to ${recommendedUpgradePlan.name}`}
                      <IconExternalLink data-icon="inline-end" />
                    </Button>
                  )}
                  <ButtonLink href="/#pricing" variant="outline">View plan options</ButtonLink>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {existingSubscriptionNeedsPortal
                    ? "Opens Stripe's self-serve plan selector for the subscription linked to this workspace."
                    : upgradeCheckoutAvailable
                    ? `Opens Stripe Checkout for ${recommendedUpgradePlan.name} on ${billingInterval} billing. The paid subscription begins at checkout.`
                    : upgradeReason}
                </p>
              </div>

              <div className="rounded-lg border border-border bg-background/60 p-4">
                <p className="text-sm font-medium">Usage left on {currentPlan.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">Counts reset monthly for reports. Client and workflow counts use active records.</p>
                <div className="mt-4 flex flex-col gap-3">
                  <BillingUsageRow label="Clients" used={usage.clients} limit={currentPlan.limits.clients} />
                  <BillingUsageRow label="Workflows" used={usage.workflows} limit={currentPlan.limits.workflows} />
                  <BillingUsageRow label="Reports this month" used={usage.reportsPerMonth} limit={currentPlan.limits.reportsPerMonth} />
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/60 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-medium">Billing period for checkout</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {recommendedUpgradePrice.note} The workspace trial is separate and never restarts at checkout.
                  </p>
                </div>
                {annualCheckoutAvailable ? (
                  <BillingIntervalToggle interval={billingInterval} onIntervalChange={setBillingInterval} />
                ) : (
                  <Badge variant="outline">Monthly billing</Badge>
                )}
              </div>
            </div>

            <div className="grid gap-2">
              {portalAvailable ? (
                <Button type="button" variant="outline" onClick={() => openPortal("manage")} disabled={!!openingBilling}>
                  {openingBilling === "portal" ? "Opening portal..." : "Manage billing details"}
                  <IconExternalLink data-icon="inline-end" />
                </Button>
              ) : (
                <Button type="button" variant="outline" disabled>
                  Manage billing details
                </Button>
              )}
              <p className="text-xs text-muted-foreground">{portalReason}</p>
              {billingMessage ? (
                <FieldDescription className={billingMessage.tone === "error" ? "text-destructive" : ""}>
                  {billingMessage.text}
                </FieldDescription>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="team">
        <Card className="border-border bg-muted/20">
          <CardHeader>
            <CardTitle>Team</CardTitle>
            <CardDescription>People currently linked to this Maintain Flow workspace.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {memberships.length ? memberships.map((membership) => (
              <div key={membership.id} className="flex flex-col gap-3 rounded-lg border border-border bg-background/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{userDisplayName(core, membership.userId)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Member since {formatDate(membership.createdAt)}</p>
                </div>
                <Badge variant={membership.role === "owner" ? "secondary" : "outline"}>{membership.role}</Badge>
              </div>
            )) : (
              <NotFoundEmpty title="No team members" description="The current user will appear here after the workspace is created." action={false} />
            )}
            <FieldDescription>
              Maintain Flow supports owner, admin, and member roles. Invite management can be added when the team workflow needs it.
            </FieldDescription>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

function billingUsageForCore(core: Core): BillingUsageSummary {
  const currentPeriod = currentMonthToDate()

  return {
    clients: core.data?.clients.filter((client) => !client.archivedAt).length ?? 0,
    workflows: core.data?.workflows.filter((workflow) => !workflow.archivedAt).length ?? 0,
    reportsPerMonth: core.data?.reports.filter((report) => report.createdAt >= currentPeriod.periodStart).length ?? 0,
  }
}

function recommendedBillingUpgrade(planId: BillingPlanId): BillingPlanId {
  if (planId === "free") return "starter"
  if (planId === "starter") return "growth"
  if (planId === "growth") return "scale"
  return "scale"
}

function billingLimitNoticeFromError(error: unknown): BillingLimitNotice | null {
  const message = error instanceof Error ? error.message : String(error || "")
  if (!message.includes("allows up to") || !message.includes("Upgrade before")) {
    return null
  }

  return { message }
}

function billingRemainingLabel(used: number, limit: number | null) {
  if (limit === null) return "Custom allowance"
  return `${Math.max(0, limit - used)} left`
}

function getTrialInfo(trialEndsAt?: string | null) {
  if (!trialEndsAt) return null
  const endDate = new Date(trialEndsAt)
  if (Number.isNaN(endDate.getTime())) return null
  const today = new Date()
  if (endDate.getTime() <= today.getTime()) return null
  const daysLeft = Math.max(1, Math.ceil((endDate.getTime() - today.getTime()) / 86_400_000))

  return {
    daysLeft,
    daysLeftLabel: `${daysLeft} ${daysLeft === 1 ? "day" : "days"}`,
    endsLabel: new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(endDate),
  }
}

function PlanLimitDialog({
  core,
  notice,
  open,
  onOpenChange,
}: {
  core: Core
  notice: BillingLimitNotice | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const currentPlan = core.agency ? getEffectiveBillingPlan(core.agency) : billingPlans.free
  const recommendedPlan = billingPlans[recommendedBillingUpgrade(currentPlan.id)]
  const highestSelfServeLimit = currentPlan.id === "scale" || currentPlan.id === "agency_plus"
  const usage = billingUsageForCore(core)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{currentPlan.name} plan limit reached</DialogTitle>
          <DialogDescription>
            {highestSelfServeLimit
              ? `${currentPlan.name} has no higher self-serve tier. Archive inactive clients or workflows, or wait for the monthly report allowance to reset.`
              : "Upgrade in Stripe to keep adding clients, workflows, and client-ready reports without waiting for approval or onboarding."}
          </DialogDescription>
        </DialogHeader>
        <Alert>
          <IconAlertTriangle aria-hidden />
          <AlertTitle>{highestSelfServeLimit ? "Self-serve capacity reached" : "Upgrade required"}</AlertTitle>
          <AlertDescription>{notice?.message ?? "This workspace has reached a package limit."}</AlertDescription>
        </Alert>
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{highestSelfServeLimit ? "Current plan" : "Recommended plan"}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {highestSelfServeLimit
                  ? "Manage or reduce current usage to make room within this plan's allowances."
                  : recommendedPlan.description}
              </p>
            </div>
            <Badge variant="secondary">{highestSelfServeLimit ? currentPlan.name : recommendedPlan.name}</Badge>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <BillingUsageRow label="Clients" used={usage.clients} limit={currentPlan.limits.clients} />
            <BillingUsageRow label="Workflows" used={usage.workflows} limit={currentPlan.limits.workflows} />
            <BillingUsageRow label="Reports this month" used={usage.reportsPerMonth} limit={currentPlan.limits.reportsPerMonth} />
          </div>
        </div>
        <DialogFooter>
          {highestSelfServeLimit ? (
            <>
              <ButtonLink href="/clients" variant="outline">Review clients</ButtonLink>
              <ButtonLink href="/workflows">Review workflows</ButtonLink>
            </>
          ) : (
            <>
              <ButtonLink href="/#pricing" variant="outline">
                View plan options
              </ButtonLink>
              <ButtonLink href="/settings?tab=billing">
                Upgrade plan
                <IconArrowRight data-icon="inline-end" />
              </ButtonLink>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BillingUsageRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-xs text-muted-foreground">{billingRemainingLabel(used, limit)}</p>
        </div>
        <p className="text-sm tabular-nums">{used} / {formatBillingLimit(limit)}</p>
      </div>
      {limit === null ? <Separator /> : <Progress value={billingLimitPercent(used, limit)} />}
    </div>
  )
}

function BillingIntervalToggle({
  interval,
  onIntervalChange,
}: {
  interval: BillingInterval
  onIntervalChange: (interval: BillingInterval) => void
}) {
  return (
    <ToggleGroup
      value={[interval]}
      onValueChange={(value) => {
        const nextInterval = value[0] as BillingInterval | undefined
        if (nextInterval) onIntervalChange(nextInterval)
      }}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Checkout billing period"
    >
      {billingIntervals.map((option) => (
        <ToggleGroupItem key={option} value={option} aria-label={`Use ${option} billing`}>
          {option === "monthly" ? "Monthly" : "Annual"}
          {option === "annual" ? (
            <Badge variant="secondary">-{annualBillingDiscountPercent}%</Badge>
          ) : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function AgencySetupCard({ onCreate, defaultName }: { onCreate: (input: { name: string; slug: string }) => void | Promise<unknown>; defaultName: string }) {
  const router = useRouter()
  const agencyNameId = useId()
  const agencySlugId = useId()
  const [name, setName] = useState(defaultName || "Maintain Flow Agency")
  const [slug, setSlug] = useState(slugify(defaultName || "maintain-flow-agency"))
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!name.trim()) {
      setError("Agency name is required.")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      await onCreate({ name, slug })
      router.replace("/dashboard")
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create the agency workspace.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="max-w-2xl border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Create agency workspace</CardTitle>
        <CardDescription>This creates the tenant boundary for clients, workflows, checks, issues, and reports.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={agencyNameId}>Agency name</FieldLabel>
            <Input id={agencyNameId} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            <FieldError>{error}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor={agencySlugId}>Workspace slug</FieldLabel>
            <Input id={agencySlugId} value={slug} maxLength={72} onChange={(event) => setSlug(event.target.value)} />
            <FieldDescription>Leave blank to generate a safe workspace slug automatically.</FieldDescription>
          </Field>
          <Button type="button" onClick={submit} disabled={submitting}>
            {submitting ? "Creating..." : "Create workspace"}
            <IconArrowRight data-icon="inline-end" />
          </Button>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}

function AddWorkflowDialog({
  core,
  fixedClientId,
  triggerLabel = "Add workflow",
  defaultOpen = false,
}: {
  core: Core
  fixedClientId?: string
  triggerLabel?: string
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [limitNotice, setLimitNotice] = useState<BillingLimitNotice | null>(null)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button type="button" />}>
          <IconPlus data-icon="inline-start" />
          {triggerLabel}
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Add workflow</DialogTitle>
            <DialogDescription>Choose a client, configure the monitor, test the endpoint, then save the first check run.</DialogDescription>
          </DialogHeader>
          <AddWorkflowWizard
            core={core}
            fixedClientId={fixedClientId}
            onLimitNotice={setLimitNotice}
            onRequestClose={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
      <PlanLimitDialog
        core={core}
        notice={limitNotice}
        open={!!limitNotice}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setLimitNotice(null)
          }
        }}
      />
    </>
  )
}

function AddWorkflowWizard({
  core,
  fixedClientId,
  onLimitNotice,
  onRequestClose,
}: {
  core: Core
  fixedClientId?: string
  onLimitNotice?: (notice: BillingLimitNotice) => void
  onRequestClose?: () => void
}) {
  const clientSelectId = useId()
  const newClientNameId = useId()
  const newClientEmailId = useId()
  const workflowNameId = useId()
  const curlId = useId()
  const importPayloadId = useId()
  const endpointUrlId = useId()
  const methodId = useId()
  const expectedStatusId = useId()
  const timeoutSecondsId = useId()
  const maxLatencyId = useId()
  const frequencyId = useId()
  const environmentId = useId()
  const assertionTypeId = useId()
  const assertionPathId = useId()
  const clients = useMemo(() => core.data?.clients.filter((client) => !client.archivedAt) ?? [], [core.data?.clients])
  const initialStep = fixedClientId ? "method" : "client"
  const clientListInitializedRef = useRef(Boolean(fixedClientId || clients.length))
  const [step, setStep] = useState<WorkflowWizardStep>(initialStep)
  const [clientId, setClientId] = useState(fixedClientId || clients[0]?.id || "new")
  const [newClientName, setNewClientName] = useState("")
  const [newClientEmail, setNewClientEmail] = useState("")
  const [setupMethod, setSetupMethod] = useState<WorkflowSetupMethod>("endpoint")
  const [name, setName] = useState(workflowWizardInitialDraft.workflowName)
  const [endpointUrl, setEndpointUrl] = useState(workflowWizardInitialDraft.endpointUrl)
  const [curl, setCurl] = useState(workflowWizardInitialDraft.curl)
  const [parsedCurl, setParsedCurl] = useState<ReturnType<typeof parseCurlCommand> | null>(null)
  const [importPayload, setImportPayload] = useState("")
  const [importResult, setImportResult] = useState<PlatformImportResult | null>(null)
  const [method, setMethod] = useState<WorkflowMethod>("GET")
  const [headers, setHeaders] = useState<Record<string, string>>({})
  const [headersText, setHeadersText] = useState("")
  const [requestBody, setRequestBody] = useState("")
  const [environment, setEnvironment] = useState<Workflow["environment"]>("production")
  const [expectedStatus, setExpectedStatus] = useState(200)
  const [timeoutSeconds, setTimeoutSeconds] = useState(10)
  const [maxLatencyMs, setMaxLatencyMs] = useState(5000)
  const [frequencyMinutes, setFrequencyMinutes] = useState(60)
  const [reportIncluded, setReportIncluded] = useState(true)
  const [assertionType, setAssertionType] = useState<AssertionType>("response_exists")
  const [assertionPath, setAssertionPath] = useState("ok")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [testResult, setTestResult] = useState<EndpointTestResult | null>(null)
  const [suggestedAssertions, setSuggestedAssertions] = useState<AssertionConfig[] | null>(null)
  const [urlScanResult, setUrlScanResult] = useState<UrlScanResult | null>(null)
  const [scanningUrl, setScanningUrl] = useState(false)
  const [error, setError] = useState("")
  const [errorField, setErrorField] = useState<WorkflowWizardField | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedWorkflowId, setSavedWorkflowId] = useState("")
  const [savedClientId, setSavedClientId] = useState("")
  const [savedIssueId, setSavedIssueId] = useState("")
  const steps: WorkflowWizardStep[] = fixedClientId
    ? ["method", "configure", "test", "save"]
    : ["client", "method", "configure", "test", "save"]
  const currentStepIndex = steps.indexOf(step) + 1
  const selectedSetupMethod = workflowSetupMethods.find((item) => item.id === setupMethod) ?? workflowSetupMethods[0]
  const currentStepDetails = workflowStepDetails[step]
  const progressPercent = Math.round((currentStepIndex / steps.length) * 100)

  useEffect(() => {
    if (fixedClientId || clientListInitializedRef.current || clients.length === 0) {
      return
    }

    clientListInitializedRef.current = true
    setClientId(clients[0].id)
  }, [clients, fixedClientId])

  function currentInput(overrides: Partial<EndpointTestInput> = {}): EndpointTestInput {
    return {
      url: (overrides.url ?? endpointUrl).trim(),
      method: overrides.method ?? method,
      headers: overrides.headers ?? currentHeaders(),
      body: overrides.body ?? requestBody,
      expectedStatus,
      timeoutSeconds,
      maxLatencyMs,
      assertions: currentAssertions(),
    }
  }

  function currentHeaders(): Record<string, string> {
    if (!headersText.trim()) {
      return headers
    }

    const parsed = JSON.parse(headersText) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Headers must be a JSON object.")
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)])
    )
  }

  function currentAssertions(): AssertionConfig[] {
    if (suggestedAssertions) {
      return suggestedAssertions
    }

    if (assertionType === "response_exists") {
      return [{ id: "response-exists", type: "response_exists", enabled: true }]
    }

    return [
      { id: "json-field-exists", type: "json_field_exists", path: assertionPath, enabled: true },
      { id: "response-exists", type: "response_exists", enabled: true },
    ]
  }

  function applySetupMethod(nextMethod: typeof setupMethod) {
    setSetupMethod(nextMethod)
    clearError()
    setTestResult(null)
    setSavedWorkflowId("")
  }

  function setFieldError(nextError: WorkflowWizardError) {
    setError(nextError.message)
    setErrorField(nextError.field)
  }

  function clearError() {
    setError("")
    setErrorField(null)
  }

  function fieldError(field: WorkflowWizardField) {
    return errorField === field ? error : ""
  }

  function parseCurl() {
    try {
      const parsed = parseCurlCommand(curl)
    setEndpointUrl(parsed.url)
    setMethod(parsed.method)
    setHeaders(parsed.headers)
    setHeadersText(JSON.stringify(parsed.headers, null, 2))
    setRequestBody(parsed.body)
    setSuggestedAssertions(null)
    setUrlScanResult(null)
    setParsedCurl(parsed)
      clearError()
      return parsed
    } catch (parseError) {
      setFieldError({ field: "curl", message: parseError instanceof Error ? parseError.message : "Could not parse cURL." })
      return null
    }
  }

  function detectImport() {
    const result = detectPlatformImport(importPayload)
    setImportResult(result)
    setName(result.name)
    if (result.endpointUrl) {
      setEndpointUrl(result.endpointUrl)
    }
    if (methodOptions.includes(result.method as WorkflowMethod)) {
      setMethod(result.method as WorkflowMethod)
    }
    if (result.warnings[0]) {
      setFieldError({ field: "importPayload", message: result.warnings[0] })
    } else {
      clearError()
    }
    return result
  }

  async function scanEndpointSuggestions() {
    if (!endpointUrl.trim()) {
      setFieldError({ field: "endpointUrl", message: "Enter a website or endpoint URL to scan." })
      return
    }

    setScanningUrl(true)
    clearError()
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (core.supabaseEnabled) {
        const token = await getValidSupabaseAccessToken()
        if (!token) throw new Error("Sign in before scanning a URL.")
        headers.Authorization = `Bearer ${token}`
      }
      const response = await fetch("/api/checks/url-scan", {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientName: currentClientName(),
          websiteUrl: endpointUrl,
          healthApiUrl: endpointUrl.includes("/health") || endpointUrl.includes("/api") ? endpointUrl : undefined,
        }),
      })
      const result = (await response.json()) as UrlScanResult
      setUrlScanResult(result)
      if (!response.ok || (!result.suggestions.length && result.warnings[0])) {
        setFieldError({ field: "endpointUrl", message: result.warnings[0] || "No URL scan suggestions were found." })
      }
    } catch (scanError) {
      setFieldError({ field: "endpointUrl", message: scanError instanceof Error ? scanError.message : "URL scan failed." })
    } finally {
      setScanningUrl(false)
    }
  }

  function currentClientName() {
    if (clientId === "new") return newClientName.trim()
    return clients.find((client) => client.id === clientId)?.name ?? core.agency?.name ?? "Client"
  }

  function applyScanSuggestion(suggestion: UrlScanSuggestion) {
    setSetupMethod("endpoint")
    setName(suggestion.workflow.name)
    setEndpointUrl(suggestion.workflow.endpointUrl)
    setMethod(suggestion.workflow.method)
    setExpectedStatus(suggestion.workflow.expectedStatus)
    setTimeoutSeconds(suggestion.workflow.timeoutSeconds)
    setMaxLatencyMs(suggestion.workflow.maxLatencyMs)
    setFrequencyMinutes(suggestion.workflow.frequencyMinutes)
    setSuggestedAssertions(suggestion.check.assertions)
    setTestResult(null)
    clearError()
  }

  async function testConnection() {
    setTesting(true)
    clearError()
    try {
      const parsedCurl = setupMethod === "curl" ? parseCurl() : null
      if (setupMethod === "curl" && !parsedCurl) return null
      const result = await core.testEndpoint(
        currentInput(
          parsedCurl
            ? {
                url: parsedCurl.url,
                method: parsedCurl.method,
            headers: parsedCurl.headers,
                body: parsedCurl.body,
              }
            : {}
        )
      )
      setTestResult(result)
      return result
    } catch (testError) {
      const message = testError instanceof Error ? testError.message : "Connection test failed."
      setError(message)
      setErrorField(null)
      return null
    } finally {
      setTesting(false)
    }
  }

  function continueFromClient() {
    const validation = validateWorkflowClientStep({ fixedClientId, clientId, newClientName })
    if (validation) {
      setFieldError(validation)
      return
    }
    clearError()
    setStep("method")
  }

  function continueFromConfigure() {
    const validation = validateWorkflowConfigureStep({
      setupMethod,
      workflowName: name,
      endpointUrl,
      curl,
      importPayload,
    })
    if (validation) {
      setFieldError(validation)
      return
    }
    if (setupMethod === "curl" && !parseCurl()) return
    if (setupMethod === "import") {
      const detected = importResult ?? detectImport()
      if (!detected) return
    }
    clearError()
    setStep("test")
  }

  function resetWizard() {
    setStep(initialStep)
    setClientId(fixedClientId || clients[0]?.id || "new")
    setNewClientName("")
    setNewClientEmail("")
    setSetupMethod("endpoint")
    setName(workflowWizardInitialDraft.workflowName)
    setEndpointUrl(workflowWizardInitialDraft.endpointUrl)
    setCurl(workflowWizardInitialDraft.curl)
    setParsedCurl(null)
    setImportPayload("")
    setImportResult(null)
    setMethod("GET")
    setHeaders({})
    setHeadersText("")
    setRequestBody("")
    setExpectedStatus(200)
    setTimeoutSeconds(10)
    setMaxLatencyMs(5000)
    setFrequencyMinutes(60)
    setReportIncluded(true)
    setSuggestedAssertions(null)
    setUrlScanResult(null)
    setScanningUrl(false)
    setAssertionType("response_exists")
    setAssertionPath("ok")
    setAdvancedOpen(false)
    setTestResult(null)
    setSaving(false)
    clearError()
    setSavedWorkflowId("")
    setSavedClientId("")
    setSavedIssueId("")
  }

  async function saveWorkflow() {
    clearError()
    setSaving(true)
    let activeClientId = fixedClientId || clientId
    try {
      const detected = setupMethod === "import" ? importResult ?? detectImport() : null
      const workflowHeaders = currentHeaders()
      const detectedEndpointUrl = (detected?.endpointUrl || endpointUrl).trim()
      const pendingImport = setupMethod === "import" && Boolean(detected?.pendingSetup || !detectedEndpointUrl)
      const monitorViolation = savedMonitorPolicyViolation({
        endpointUrl: detectedEndpointUrl,
        method,
        headers: workflowHeaders,
        requestBody: setupMethod === "import" ? "" : requestBody,
      }, { allowEmptyEndpoint: pendingImport })
      if (monitorViolation) throw new Error(monitorViolation)
      const assertionViolation = savedAssertionsViolation(currentAssertions())
      if (assertionViolation) throw new Error(assertionViolation)
      if (activeClientId === "new") {
        const existingClientIds = new Set((core.data?.clients ?? []).map((client) => client.id))
        const nextDatabase = await core.createClient({ name: newClientName, reportRecipientEmail: newClientEmail })
        const createdClient = nextDatabase.clients.find((client) =>
          client.agencyId === core.agency?.id &&
          !existingClientIds.has(client.id) &&
          client.name === newClientName.trim() &&
          client.reportRecipientEmail.trim() === newClientEmail.trim()
        )
        if (!createdClient) {
          throw new Error("The client was created but could not be selected for workflow setup. Refresh and select it before retrying.")
        }
        activeClientId = createdClient.id
        setClientId(activeClientId)
      }
      if (!activeClientId) throw new Error("Select or create a client.")

      if (setupMethod === "import") {
        if (!detected) throw new Error("Detect the import before saving.")
        const detectedWorkflowName = (detected.name || name).trim()
        if (detected.pendingSetup || !detectedEndpointUrl.trim()) {
          const nextDatabase = await core.savePendingWorkflow({
            clientId: activeClientId,
            name: detectedWorkflowName,
            endpointUrl: detectedEndpointUrl,
            method: "GET",
            headers: {},
            requestBody: "",
            expectedStatus,
            timeoutSeconds,
            maxLatencyMs,
            frequencyMinutes,
            retries: 2,
            reportIncluded,
            storeRawResponse: false,
            environment,
            type: detected.platform === "n8n" ? "n8n" : detected.platform === "make" ? "make" : detected.platform === "zapier" ? "zapier" : "http_endpoint",
            assertions: currentAssertions(),
            pendingReason: detected.warnings[0] ?? "Add a callable production URL or heartbeat endpoint before monitoring.",
          })
          const created = findPersistedWorkflow(nextDatabase.workflows, {
            clientId: activeClientId,
            name: detectedWorkflowName,
            endpointUrl: detectedEndpointUrl,
          })
          if (!created) {
            throw new Error("Workflow was saved locally but was not visible after server reload. Refresh and try again.")
          }
          setSavedWorkflowId(created.id)
          setSavedClientId(activeClientId)
          setSavedIssueId("")
          setStep("save")
          return
        }
      }

      const result = testResult ?? (detected
        ? await core.testEndpoint(currentInput({ url: detected.endpointUrl || endpointUrl }))
        : await testConnection())
      if (!result) return
      const nextDatabase = await core.saveWorkflow(
        {
          clientId: activeClientId,
          name: name.trim(),
          endpointUrl: (detected?.endpointUrl || endpointUrl).trim(),
          method,
          headers: workflowHeaders,
          requestBody,
          expectedStatus,
          timeoutSeconds,
          maxLatencyMs,
          frequencyMinutes,
          retries: 2,
          reportIncluded,
          storeRawResponse: false,
          environment,
          type: "http_endpoint",
          assertions: currentAssertions(),
        },
        result
      )
      const created = findPersistedWorkflow(nextDatabase.workflows, {
        clientId: activeClientId,
        name: name.trim(),
        endpointUrl: (detected?.endpointUrl || endpointUrl).trim(),
      })
      if (!created) {
        throw new Error("Workflow was saved locally but was not visible after server reload. Refresh and try again.")
      }
      setSavedWorkflowId(created.id)
      setSavedClientId(activeClientId)
      const createdIssue = nextDatabase.issues.find((issue) => issue.workflowId === created.id && !["resolved", "ignored"].includes(issue.status))
      setSavedIssueId(createdIssue?.id ?? "")
      setStep("save")
    } catch (saveError) {
      const notice = billingLimitNoticeFromError(saveError)
      if (notice) {
        onRequestClose?.()
        onLimitNotice?.(notice)
      }
      setError(saveError instanceof Error ? saveError.message : "Could not save workflow.")
      setErrorField(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-border bg-background/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-muted-foreground">Guided setup</p>
            <p className="mt-1 text-lg font-medium">{currentStepDetails.title}</p>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{currentStepDetails.description}</p>
          </div>
          <Badge variant="secondary" className="w-fit shrink-0">{progressPercent}% complete</Badge>
        </div>
        <div className="mt-4">
          <WorkflowStepProgress steps={steps} currentStep={step} />
        </div>
      </div>
      {step === "client" ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={clientSelectId}>Client</FieldLabel>
            <NativeSelect id={clientSelectId} value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <NativeSelectOption value="new">Create client inline</NativeSelectOption>
              {clients.map((client) => (
                <NativeSelectOption key={client.id} value={client.id}>{client.name}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {clientId === "new" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Field data-invalid={!!fieldError("newClientName")}>
                <FieldLabel htmlFor={newClientNameId}>Client name</FieldLabel>
                <Input id={newClientNameId} value={newClientName} onChange={(event) => setNewClientName(event.target.value)} placeholder={workflowWizardPlaceholders.clientName} />
                <FieldError>{fieldError("newClientName")}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor={newClientEmailId}>Report recipient</FieldLabel>
                <Input id={newClientEmailId} value={newClientEmail} onChange={(event) => setNewClientEmail(event.target.value)} placeholder={workflowWizardPlaceholders.clientEmail} />
              </Field>
            </div>
          ) : null}
          <WizardActions currentStepIndex={currentStepIndex} totalSteps={steps.length}>
            <Button type="button" onClick={continueFromClient}>
              Continue
              <IconArrowRight data-icon="inline-end" />
            </Button>
          </WizardActions>
        </FieldGroup>
      ) : null}
      {step === "method" ? (
        <FieldGroup>
          <Field>
            <FieldLabel>Setup method</FieldLabel>
            <div className="grid gap-3 md:grid-cols-3">
              {workflowSetupMethods.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  variant={setupMethod === item.id ? "default" : "outline"}
                  className="h-auto min-h-28 flex-col items-start justify-start gap-2 rounded-lg px-4 py-3 text-left whitespace-normal"
                  onClick={() => applySetupMethod(item.id)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <item.icon aria-hidden className="size-4" />
                    {item.label}
                  </span>
                  <span className={cn("text-xs leading-5", setupMethod === item.id ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {item.description}
                  </span>
                </Button>
              ))}
            </div>
            <FieldDescription>{selectedSetupMethod.helper}</FieldDescription>
          </Field>
          <WizardActions currentStepIndex={currentStepIndex} totalSteps={steps.length}>
            {!fixedClientId ? <Button type="button" variant="outline" onClick={() => setStep("client")}>Back</Button> : null}
            <Button type="button" onClick={() => setStep("configure")}>
              Configure
              <IconArrowRight data-icon="inline-end" />
            </Button>
          </WizardActions>
        </FieldGroup>
      ) : null}
      {step === "configure" ? (
        <FieldGroup>
          <Field data-invalid={!!fieldError("workflowName")}>
            <FieldLabel htmlFor={workflowNameId}>Workflow name</FieldLabel>
            <Input id={workflowNameId} value={name} onChange={(event) => setName(event.target.value)} placeholder={workflowWizardPlaceholders.workflowName} />
            <FieldError>{fieldError("workflowName")}</FieldError>
          </Field>
          {setupMethod === "curl" ? (
            <Field data-invalid={!!fieldError("curl")}>
              <FieldLabel htmlFor={curlId}>cURL command</FieldLabel>
              <Textarea id={curlId} value={curl} onChange={(event) => setCurl(event.target.value)} rows={4} placeholder={workflowWizardPlaceholders.curl} />
              <FieldError>{fieldError("curl")}</FieldError>
              <Button type="button" variant="outline" onClick={parseCurl}>Parse cURL</Button>
              {parsedCurl ? (
                <div className="rounded-lg border border-border bg-background/45 p-3 text-sm">
                  <p className="font-medium">Parsed preview</p>
                  <p className="mt-1 text-xs text-muted-foreground">Method: {parsedCurl.method} · URL: {parsedCurl.url}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Headers: {Object.keys(parsedCurl.headers).length} found · Body: {parsedCurl.body ? "detected" : "none"}
                  </p>
                </div>
              ) : null}
            </Field>
          ) : null}
          {setupMethod === "import" ? (
            <Field data-invalid={!!fieldError("importPayload")}>
              <FieldLabel htmlFor={importPayloadId}>Import payload</FieldLabel>
              <Textarea
                id={importPayloadId}
                value={importPayload}
                onChange={(event) => setImportPayload(event.target.value)}
                rows={5}
                placeholder={workflowWizardPlaceholders.importPayload}
              />
              <FieldError>{fieldError("importPayload")}</FieldError>
              <Button type="button" variant="outline" onClick={detectImport}>Detect import</Button>
              {importResult ? (
                <div className="rounded-lg border border-border bg-background/45 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{importResult.platform}</span>
                    <Badge variant={importResult.pendingSetup ? "outline" : "secondary"}>
                      {importResult.pendingSetup ? "Pending URL" : "Callable URL detected"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {importResult.warnings[0] || `Suggested checks: ${importResult.suggestedChecks.join(", ")}`}
                  </p>
                </div>
              ) : null}
            </Field>
          ) : null}
          <Field data-invalid={!!fieldError("endpointUrl")}>
            <FieldLabel htmlFor={endpointUrlId}>Endpoint URL</FieldLabel>
            <Input
              id={endpointUrlId}
              value={endpointUrl}
              onChange={(event) => {
                setEndpointUrl(event.target.value)
                setUrlScanResult(null)
              }}
              placeholder={workflowWizardPlaceholders.endpointUrl}
            />
            <FieldError>{fieldError("endpointUrl")}</FieldError>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button type="button" variant="outline" onClick={() => void scanEndpointSuggestions()} disabled={scanningUrl}>
                <IconHeartbeat data-icon="inline-start" />
                {scanningUrl ? "Scanning..." : "Scan URL for suggestions"}
              </Button>
              <FieldDescription>
                Suggest homepage, key-page, and health/API checks using the same endpoint safety rules as live checks.
              </FieldDescription>
            </div>
            {urlScanResult ? (
              <div className="rounded-lg border border-border bg-background/45 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Suggested checks</p>
                  <Badge variant="secondary">{urlScanResult.suggestions.length}</Badge>
                </div>
                {urlScanResult.warnings.length ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {urlScanResult.warnings.slice(0, 2).map((warning) => (
                      <p key={warning} className="text-xs leading-5 text-muted-foreground">{warning}</p>
                    ))}
                  </div>
                ) : null}
                <div className="mt-3 grid gap-2">
                  {urlScanResult.suggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      className="rounded-md border border-border bg-background/70 p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => applyScanSuggestion(suggestion)}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">{suggestion.label}</span>
                        <Badge variant="outline">{suggestion.workflow.method}</Badge>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{suggestion.reason}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={methodId}>Method</FieldLabel>
            <NativeSelect id={methodId} value={method} onChange={(event) => setMethod(event.target.value as WorkflowMethod)}>
              {methodOptions.map((item) => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <div className="rounded-lg border border-border bg-background/45">
              <CollapsibleTrigger render={<Button type="button" variant="ghost" className="flex w-full justify-between px-3" />}>
                Advanced settings
                <IconChevronDown data-icon="inline-end" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col gap-4 p-3 pt-0">
                  <div className="grid gap-3 md:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor={expectedStatusId}>Expected status</FieldLabel>
                      <Input id={expectedStatusId} type="number" value={expectedStatus} onChange={(event) => setExpectedStatus(Number(event.target.value))} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={timeoutSecondsId}>Timeout seconds</FieldLabel>
                      <Input id={timeoutSecondsId} type="number" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={maxLatencyId}>Max latency ms</FieldLabel>
                      <Input id={maxLatencyId} type="number" value={maxLatencyMs} onChange={(event) => setMaxLatencyMs(Number(event.target.value))} />
                    </Field>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor={frequencyId}>Frequency</FieldLabel>
                      <NativeSelect id={frequencyId} value={String(frequencyMinutes)} onChange={(event) => setFrequencyMinutes(Number(event.target.value))}>
                        {frequencyOptions.map((item) => <NativeSelectOption key={item.value} value={String(item.value)}>{item.label}</NativeSelectOption>)}
                      </NativeSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={environmentId}>Environment</FieldLabel>
                      <NativeSelect id={environmentId} value={environment} onChange={(event) => setEnvironment(event.target.value as Workflow["environment"])}>
                        <NativeSelectOption value="production">Production</NativeSelectOption>
                        <NativeSelectOption value="staging">Staging</NativeSelectOption>
                        <NativeSelectOption value="development">Development</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={assertionTypeId}>Assertion</FieldLabel>
                      <NativeSelect id={assertionTypeId} value={assertionType} onChange={(event) => { setAssertionType(event.target.value as AssertionType); setSuggestedAssertions(null) }}>
                        <NativeSelectOption value="response_exists">Response exists</NativeSelectOption>
                        <NativeSelectOption value="json_field_exists">JSON field exists</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                  </div>
                  {assertionType === "json_field_exists" ? (
                    <Field>
                      <FieldLabel htmlFor={assertionPathId}>JSON field path</FieldLabel>
                      <Input id={assertionPathId} value={assertionPath} onChange={(event) => { setAssertionPath(event.target.value); setSuggestedAssertions(null) }} placeholder="ok" />
                      <FieldDescription>Saved checks only store short dot-separated field names, never expected values.</FieldDescription>
                    </Field>
                  ) : null}
                  <Alert>
                    <IconHeartbeat />
                    <AlertTitle>Credential-free saved monitor</AlertTitle>
                    <AlertDescription>
                      Launch monitoring stores only a public HTTPS GET URL with no query, fragment, custom headers, or request body.
                    </AlertDescription>
                  </Alert>
                  <div className="flex items-center justify-between rounded-lg border border-border bg-background/45 p-3">
                    <div>
                      <p className="text-sm font-medium">Include in reports</p>
                      <p className="text-xs text-muted-foreground">Raw response storage remains off by default.</p>
                    </div>
                    <Switch
                      aria-label="Include workflow in client reports"
                      checked={reportIncluded}
                      onCheckedChange={setReportIncluded}
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
          <WizardActions currentStepIndex={currentStepIndex} totalSteps={steps.length}>
            <Button type="button" variant="outline" onClick={() => setStep("method")}>Back</Button>
            <Button type="button" onClick={continueFromConfigure}>
              Continue to test
              <IconArrowRight data-icon="inline-end" />
            </Button>
          </WizardActions>
        </FieldGroup>
      ) : null}
      {step === "test" ? (
        <FieldGroup>
          <div className="rounded-lg border border-border bg-background/45 p-4">
            <p className="text-sm font-medium">{name}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{method} {endpointUrl}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={testConnection} disabled={testing || saving}>
              <IconPlayerPlay data-icon="inline-start" />
              {testing ? "Testing" : "Test connection"}
            </Button>
            <Button type="button" onClick={saveWorkflow} disabled={testing || saving}>
              <IconCircleCheck data-icon="inline-start" />
              {saving ? "Saving..." : setupMethod === "import" && importResult?.pendingSetup ? "Save pending" : "Save monitor"}
            </Button>
          </div>
          {testResult ? <ConnectionResult result={testResult} /> : null}
          {error ? <FieldDescription className="text-destructive">{error}</FieldDescription> : null}
          <WizardActions currentStepIndex={currentStepIndex} totalSteps={steps.length}>
            <Button type="button" variant="outline" onClick={() => setStep("configure")}>Back</Button>
          </WizardActions>
        </FieldGroup>
      ) : null}
      {step === "save" ? (
        <div className="rounded-lg border border-border bg-background/45 p-4">
          <p className="text-sm font-medium">
            {setupMethod === "import" && importResult?.pendingSetup ? "Workflow saved pending setup." : "Workflow is now being monitored."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {setupMethod === "import" && importResult?.pendingSetup
              ? "Add a callable production URL or heartbeat before checks can run."
              : "Default health check and first official check run were stored and reloaded from the workflow registry."}
          </p>
          {savedIssueId ? (
            <Alert className="mt-4 border-destructive/30 bg-destructive/5">
              <IconAlertTriangle aria-hidden />
              <AlertTitle>Failed first check created an issue</AlertTitle>
              <AlertDescription>
                Record what was repaired, then run the check again. The issue is resolved only after a newer passing run verifies the fix.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <SummaryTile label="Registry" value="Verified" />
            <SummaryTile label="Client" value={clientNameForId(core, savedClientId)} />
            <SummaryTile label="Report" value={reportIncluded ? "Included" : "Excluded"} />
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {savedIssueId ? (
              <ButtonLink href={`/issues/${savedIssueId}`} size="sm" onClick={onRequestClose}>
                Review issue
                <IconArrowRight data-icon="inline-end" />
              </ButtonLink>
            ) : (
              <ButtonLink href={`/workflows/${savedWorkflowId}`} size="sm" onClick={onRequestClose}>
                View workflow
                <IconArrowRight data-icon="inline-end" />
              </ButtonLink>
            )}
            <ButtonLink href="/workflows" size="sm" variant="outline" onClick={onRequestClose}>Open registry</ButtonLink>
            <ButtonLink href="/reports" size="sm" variant="outline" onClick={onRequestClose}>Generate report</ButtonLink>
            <Button type="button" size="sm" variant="outline" onClick={resetWizard}>Add another workflow</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function WizardActions({
  currentStepIndex,
  totalSteps,
  children,
}: {
  currentStepIndex: number
  totalSteps: number
  children: ReactNode
}) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-3 border-t border-border bg-background/95 px-1 py-4 supports-backdrop-filter:backdrop-blur sm:flex-row sm:items-center sm:justify-between">
      <FieldDescription>Step {currentStepIndex} of {totalSteps}</FieldDescription>
      <div className="flex flex-col gap-2 sm:flex-row">{children}</div>
    </div>
  )
}

function WorkflowStepProgress({
  steps,
  currentStep,
}: {
  steps: WorkflowWizardStep[]
  currentStep: WorkflowWizardStep
}) {
  const currentIndex = steps.indexOf(currentStep)
  const progressValue = steps.length <= 1 ? 100 : (currentIndex / (steps.length - 1)) * 100

  return (
    <div className="flex flex-col gap-3">
      <Progress value={progressValue} />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((item, index) => {
          const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming"

          return (
            <div
              key={item}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/45 px-3 py-2",
                state === "current" ? "border-primary/50 bg-primary/10" : "",
                state === "complete" ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                  state === "complete" ? "border-primary bg-primary text-primary-foreground" : "",
                  state === "current" ? "border-primary text-primary" : "",
                  state === "upcoming" ? "border-border" : ""
                )}
              >
                {state === "complete" ? <IconCircleCheck aria-hidden className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0 truncate text-xs font-medium">{workflowStepLabel(item)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function workflowStepLabel(step: "client" | "method" | "configure" | "test" | "save") {
  const labels = {
    client: "Client",
    method: "Method",
    configure: "Configure",
    test: "Test",
    save: "Save",
  }
  return labels[step]
}

function ConnectionResult({ result }: { result: EndpointTestResult }) {
  return (
    <div className="rounded-lg border border-border bg-background/45 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {result.status === "healthy" ? "Connection successful" : result.status === "skipped" ? "Test inconclusive" : "Connection needs attention"}
        </p>
        <Badge variant={statusVariant(result.status)}>{checkStatusLabel(result.status)}</Badge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Status: {result.statusCode ?? "none"} · Latency: {result.latencyMs ? `${result.latencyMs}ms` : "n/a"} · {result.errorMessage || result.safeResponseSummary}
      </p>
    </div>
  )
}

function findPersistedWorkflow(
  workflows: Workflow[],
  input: { clientId: string; name: string; endpointUrl: string }
) {
  return workflows.find((workflow) =>
    workflow.clientId === input.clientId &&
    workflow.name === input.name.trim() &&
    workflow.endpointUrl === input.endpointUrl
  )
}

function AddClientDialog({
  core,
  triggerLabel = "Add client",
  defaultOpen = false,
}: {
  core: Core
  triggerLabel?: string
  defaultOpen?: boolean
}) {
  const nameId = useId()
  const emailId = useId()
  const notesId = useId()
  const [open, setOpen] = useState(defaultOpen)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState("")
  const [limitNotice, setLimitNotice] = useState<BillingLimitNotice | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  async function create() {
    if (!name.trim()) {
      setError("Client name is required.")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      await core.createClient({ name, reportRecipientEmail: email, notes })
      setName("")
      setEmail("")
      setNotes("")
      setOpen(false)
    } catch (createError) {
      const notice = billingLimitNoticeFromError(createError)
      if (notice) {
        setOpen(false)
        setLimitNotice(notice)
      }
      setError(createError instanceof Error ? createError.message : "Could not add the client.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button type="button" />}>
          <IconPlus data-icon="inline-start" />
          {triggerLabel}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add client</DialogTitle>
            <DialogDescription>Create the selected-client boundary for workflows and reports.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor={nameId}>Client name</FieldLabel>
              <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme AI Systems" />
              <FieldError>{error}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor={emailId}>Report recipient</FieldLabel>
              <Input id={emailId} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ops@client.com" />
            </Field>
            <Field>
              <FieldLabel htmlFor={notesId}>Notes</FieldLabel>
              <Textarea id={notesId} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
            <Button type="button" onClick={create} disabled={submitting}>
              <IconPlus data-icon="inline-start" />
              {submitting ? "Adding..." : "Add client"}
            </Button>
          </FieldGroup>
        </DialogContent>
      </Dialog>
      <PlanLimitDialog
        core={core}
        notice={limitNotice}
        open={!!limitNotice}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setLimitNotice(null)
          }
        }}
      />
    </>
  )
}

function ClientsTable({
  core,
  autoOpenAddClient = false,
}: {
  core: Core
  autoOpenAddClient?: boolean
}) {
  const [query, setQuery] = useState("")
  const clients = core.data?.clients ?? []
  const filteredClients = clients
    .filter((client) => `${client.name} ${client.reportRecipientEmail} ${client.notes}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))

  if (!clients.length) {
    return (
      <NotFoundEmpty
        title="No clients yet"
        description="Add your first client to start the core loop."
        action={<AddClientDialog core={core} triggerLabel="Add client" defaultOpen={autoOpenAddClient} />}
      />
    )
  }

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Client portfolio</CardTitle>
        <CardDescription>Coverage, open issues, latest report proof, and the next best action for each retained client.</CardDescription>
        <CardAction>
          <AddClientDialog core={core} triggerLabel="Add client" defaultOpen={autoOpenAddClient} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="mb-4">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients" />
        </div>
        <div className="flex flex-col gap-3 md:hidden">
          {filteredClients.map((client) => {
            const summary = clientOperationsSummary(core, client)
            return (
              <div key={client.id} className="rounded-lg border border-border bg-background/45 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{client.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{client.reportRecipientEmail || "No recipient"}</p>
                  </div>
                  <Badge variant={summary.healthVariant}>{summary.healthLabel}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <SummaryTile label="Workflows" value={summary.workflows.length} />
                  <SummaryTile label="Issues" value={summary.openIssues.length} />
                  <SummaryTile label="Last check" value={summary.latestRun?.status ?? "No runs"} />
                  <SummaryTile label="Report proof" value={summary.latestReport?.status ?? "No proof"} />
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {summary.latestReport
                    ? `Latest proof: ${formatDateRange(summary.latestReport.periodStart, summary.latestReport.periodEnd)}.`
                    : "No client proof report has been generated yet."}
                </p>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{summary.nextAction.detail}</p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <ButtonLink href={summary.nextAction.href} size="sm">
                    {summary.nextAction.label}
                  </ButtonLink>
                  <ButtonLink href={`/clients/${client.id}`} size="sm" variant="outline">Open client</ButtonLink>
                  {!client.archivedAt ? <Button type="button" size="sm" variant="ghost" onClick={() => core.archiveClient(client.id)}>Archive</Button> : null}
                </div>
              </div>
            )
          })}
        </div>
        <div className="hidden md:block">
          <Table>
          <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Workflows</TableHead>
                <TableHead>Open issues</TableHead>
                <TableHead>Last report</TableHead>
                <TableHead>Next action</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
          </TableHeader>
          <TableBody>
            {filteredClients.map((client) => {
              const summary = clientOperationsSummary(core, client)
              return (
                <TableRow key={client.id}>
                  <TableCell>
                    <div className="flex min-w-56 flex-col gap-1">
                      <span className="font-medium">{client.name}</span>
                      <span className="text-xs text-muted-foreground">{client.reportRecipientEmail || "No recipient"}</span>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={summary.healthVariant}>{summary.healthLabel}</Badge></TableCell>
                  <TableCell>{summary.workflows.length}</TableCell>
                  <TableCell>{summary.openIssues.length}</TableCell>
                  <TableCell>
                    <div className="flex min-w-44 flex-col gap-1">
                      <span>{summary.latestReport?.status ?? "Not generated"}</span>
                      <span className="text-xs text-muted-foreground">
                        {summary.latestReport ? formatDateRange(summary.latestReport.periodStart, summary.latestReport.periodEnd) : "No client proof yet"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ButtonLink href={summary.nextAction.href} size="sm">
                      {summary.nextAction.label}
                    </ButtonLink>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <ButtonLink href={`/clients/${client.id}`} size="sm" variant="outline">Open</ButtonLink>
                      {!client.archivedAt ? <Button type="button" size="sm" variant="ghost" onClick={() => core.archiveClient(client.id)}>Archive</Button> : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function clientOperationsSummary(core: Core, client: Client) {
  const workflows = core.data?.workflows.filter((workflow) => workflow.clientId === client.id && !workflow.archivedAt) ?? []
  const openIssues = core.data?.issues.filter((issue) =>
    issue.clientId === client.id && !["resolved", "ignored"].includes(issue.status)
  ) ?? []
  const reports = (core.data?.reports.filter((report) => report.clientId === client.id) ?? [])
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  const latestReport = reports[0]
  const latestRun = (core.data?.checkRuns.filter((run) => workflows.some((workflow) => workflow.id === run.workflowId)) ?? [])
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0]
  const priorityIssue = openIssues.find((issue) => ["critical", "high"].includes(issue.severity)) ?? openIssues[0]
  const readyReport = reports.find((report) => report.status === "ready")
  const healthLabel = openIssues.length
    ? "Needs review"
    : workflows.length === 0
      ? "Needs monitor"
      : latestRun && latestRun.status !== "healthy"
        ? `Last check ${checkStatusLabel(latestRun.status).toLowerCase()}`
        : "No open issues"
  const healthVariant = openIssues.length || latestRun?.status === "failed"
    ? "destructive" as const
    : latestRun?.status === "degraded" || workflows.length === 0
      ? "outline" as const
      : "secondary" as const
  const nextAction = priorityIssue
    ? {
        label: "Review issue",
        href: `/issues/${priorityIssue.id}`,
        detail: `${priorityIssue.title} needs resolution before the next report.`,
      }
    : workflows.length === 0
      ? {
          label: "Add workflow",
          href: `/clients/${client.id}`,
          detail: "No monitored workflows yet. Connect the first workflow for this client.",
        }
      : readyReport
        ? {
            label: "Preview report",
            href: `/reports/${readyReport.id}`,
            detail: "A client-ready report is available to review or send.",
          }
        : latestReport
          ? {
              label: "Open report",
              href: `/reports/${latestReport.id}`,
              detail: "Latest report exists. Review evidence and delivery readiness.",
            }
          : {
              label: "Generate report",
              href: "/reports",
              detail: "Workflow evidence exists. Generate this client’s first proof report.",
            }

  return { workflows, openIssues, reports, latestReport, latestRun, nextAction, healthLabel, healthVariant }
}

function WorkflowsTable({
  core,
  autoOpenAddWorkflow = false,
}: {
  core: Core
  autoOpenAddWorkflow?: boolean
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<WorkflowRegistryFilter>("all")
  const [copiedEndpointId, setCopiedEndpointId] = useState("")
  const [nowMs] = useState(() => Date.now())
  const workflows = core.data?.workflows.filter((workflow) => !workflow.archivedAt) ?? []
  const filterOptions = workflowRegistryFilters.map((option) => ({
    ...option,
    count: workflows.filter((workflow) => workflowMatchesRegistryFilter(core, workflow, option.id, nowMs)).length,
  }))
  const filteredWorkflows = workflows.filter((workflow) => {
    const client = core.data?.clients.find((item) => item.id === workflow.clientId)
    const matchesQuery = `${workflow.name} ${workflow.endpointUrl} ${client?.name ?? ""} ${workflow.status}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && workflowMatchesRegistryFilter(core, workflow, filter, nowMs)
  })

  async function copyEndpoint(workflow: Workflow) {
    await navigator.clipboard?.writeText(`${workflow.method} ${workflow.endpointUrl}`)
    setCopiedEndpointId(workflow.id)
    window.setTimeout(() => setCopiedEndpointId((current) => current === workflow.id ? "" : current), 1800)
  }

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Workflow registry</CardTitle>
        <CardDescription>Every row has a default health check and stored run history.</CardDescription>
        <CardAction>
          <AddWorkflowDialog core={core} defaultOpen={autoOpenAddWorkflow} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {!workflows.length ? (
          <NotFoundEmpty
            title="No workflows connected"
            description="Add the first workflow to create a default health check and first run."
            action={<AddWorkflowDialog core={core} triggerLabel="Start guided workflow setup" />}
          />
        ) : (
          <>
        <div className="mb-4 flex flex-col gap-3">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workflows, clients, endpoints" />
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <FieldDescription>Filter the registry by the state that needs attention.</FieldDescription>
            <ToggleGroup
              value={[filter]}
              onValueChange={(value) => {
                const nextFilter = value[0] as WorkflowRegistryFilter | undefined
                if (nextFilter) {
                  setFilter(nextFilter)
                }
              }}
              variant="outline"
              size="sm"
              spacing={0}
              className="flex-wrap"
              aria-label="Workflow registry filter"
            >
              {filterOptions.map((option) => (
                <ToggleGroupItem key={option.id} value={option.id} aria-label={`Show ${option.label.toLowerCase()} workflows`}>
                  {option.label}
                  <Badge variant={filter === option.id ? "secondary" : "outline"}>{option.count}</Badge>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
        {!filteredWorkflows.length ? (
          <NotFoundEmpty
            title="No workflows match this search"
            description="Clear the search or reset the filter to return to the full workflow registry."
            action={<Button type="button" variant="outline" onClick={() => { setQuery(""); setFilter("all") }}>Clear search and filters</Button>}
          />
        ) : (
          <>
        <div className="flex flex-col gap-3 lg:hidden">
          {filteredWorkflows.map((workflow) => {
            const client = core.data?.clients.find((item) => item.id === workflow.clientId)
            const workflowRuns = core.data?.checkRuns.filter((run) => run.workflowId === workflow.id) ?? []
            const lastRun = workflowRuns[0]
            const dueLabel = workflowDueLabel(core, workflow, nowMs)
            return (
              <div key={workflow.id} className={cn(
                "rounded-lg border bg-background/45 p-3",
                workflow.status === "failed" ? "border-destructive/40" : "border-border"
              )}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{workflow.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{client?.name ?? "Unknown client"}</p>
                  </div>
                  <Badge variant={statusVariant(workflow.status)}>
                    {workflowStatusLabel(workflow)}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <p className="min-w-0 truncate text-xs text-muted-foreground" title={`${workflow.method} ${workflow.endpointUrl}`}>
                    {workflow.method} {workflow.endpointUrl}
                  </p>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Copy endpoint for ${workflow.name}`} onClick={() => void copyEndpoint(workflow)}>
                    <IconCopy aria-hidden />
                  </Button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <SummaryTile label="Latency" value={lastRun?.latencyMs ? `${lastRun.latencyMs}ms` : "n/a"} />
                  <SummaryTile label="Pass rate" value={`${workflowPassRate(workflowRuns)}%`} />
                  <SummaryTile label="Due" value={dueLabel} />
                  <SummaryTile label="Report" value={workflow.reportIncluded ? "Included" : "Excluded"} />
                  <SummaryTile label="Last run" value={formatDate(lastRun?.createdAt)} />
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <RunCheckButton core={core} workflow={workflow} />
                  <ButtonLink href={`/workflows/${workflow.id}`} size="sm" variant="outline">Open</ButtonLink>
                  {copiedEndpointId === workflow.id ? <Badge variant="secondary">Copied</Badge> : null}
                </div>
              </div>
            )
          })}
        </div>
        <div className="hidden lg:block">
          <Table className="min-w-[76rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Pass rate</TableHead>
              <TableHead>Report</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredWorkflows.map((workflow) => {
              const client = core.data?.clients.find((item) => item.id === workflow.clientId)
              const workflowRuns = core.data?.checkRuns.filter((run) => run.workflowId === workflow.id) ?? []
              const lastRun = workflowRuns[0]
              const dueLabel = workflowDueLabel(core, workflow, nowMs)
              return (
                <TableRow key={workflow.id} className={workflow.status === "failed" ? "bg-destructive/5" : undefined}>
                  <TableCell>
                    <div className="flex min-w-48 flex-col gap-1">
                      <span className="font-medium">{workflow.name}</span>
                      <span className="text-xs text-muted-foreground">{workflow.method}</span>
                    </div>
                  </TableCell>
                  <TableCell>{client?.name ?? "Unknown"}</TableCell>
                  <TableCell className="max-w-72">
                    <div className="flex items-center gap-2">
                      <span className="block min-w-0 truncate text-xs text-muted-foreground" title={workflow.endpointUrl}>
                        {workflow.endpointUrl}
                      </span>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Copy endpoint for ${workflow.name}`} onClick={() => void copyEndpoint(workflow)}>
                        <IconCopy aria-hidden />
                      </Button>
                      {copiedEndpointId === workflow.id ? <Badge variant="secondary">Copied</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(workflow.status)}>
                      {workflowStatusLabel(workflow)}
                    </Badge>
                  </TableCell>
                  <TableCell>{dueLabel}</TableCell>
                  <TableCell>{lastRun?.latencyMs ? `${lastRun.latencyMs}ms` : "n/a"}</TableCell>
                  <TableCell>{workflowPassRate(workflowRuns)}%</TableCell>
                  <TableCell>{workflow.reportIncluded ? "Included" : "Excluded"}</TableCell>
                  <TableCell>{formatDate(lastRun?.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <RunCheckButton core={core} workflow={workflow} />
                      <ButtonLink href={`/workflows/${workflow.id}`} size="sm" variant="outline">Open</ButtonLink>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          </Table>
        </div>
          </>
        )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function RunCheckButton({ core, workflow }: { core: Core; workflow: Workflow }) {
  const [running, setRunning] = useState(false)
  const activeChecks = workflowChecksForWorkflow(core, workflow)
    .filter((check) => check.enabled && !check.pendingSetup)
  const pendingSetup = activeChecks.length === 0
  async function run() {
    setRunning(true)
    try {
      await core.runCheck(workflow.id)
    } finally {
      setRunning(false)
    }
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={run} disabled={running || pendingSetup}>
      <IconPlayerPlay data-icon="inline-start" />
      {pendingSetup
        ? "Pending setup"
        : running
          ? "Running"
          : activeChecks.length > 1
            ? `Run all (${activeChecks.length})`
            : "Run"}
    </Button>
  )
}

function RunHistoryTable({ runs, title = "Run history" }: { runs: CheckRun[]; title?: string }) {
  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Status, latency, assertion results, safe response summary, and failure reason.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>HTTP</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Assertions</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{formatDate(run.createdAt)}</TableCell>
                <TableCell><Badge variant={statusVariant(run.status)}>{checkStatusLabel(run.status)}</Badge></TableCell>
                <TableCell>
                  <HttpStatusBadge statusCode={run.statusCode} />
                </TableCell>
                <TableCell>{run.latencyMs ? `${run.latencyMs}ms` : "n/a"}</TableCell>
                <TableCell>
                  {run.assertionResults.length ? (
                    <div className="flex flex-col gap-1">
                      {run.assertionResults.map((assertion) => (
                        <Badge key={assertion.id} variant={assertion.passed ? "secondary" : "destructive"}>
                          {assertion.label}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">No assertions</span>
                  )}
                </TableCell>
                <TableCell className="max-w-md text-xs text-muted-foreground">{run.errorMessage || run.safeResponseSummary}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function ActionCenterScreen({ core }: { core: Core }) {
  const issues = core.data?.issues.filter((issue) => !["resolved", "ignored"].includes(issue.status)) ?? []
  const runs = core.data?.checkRuns.slice(0, 8) ?? []
  const [nowMs] = useState(() => Date.now())
  const dueChecks = core.data?.checks.filter((check) => {
    if (!check.enabled || check.pendingSetup || !check.nextRunAt) return false
    return new Date(check.nextRunAt).getTime() <= nowMs
  }) ?? []
  const highPriorityIssues = issues.filter((issue) => ["critical", "high"].includes(issue.severity))
  const reportReadyCount = core.data?.reports.filter((report) => report.status === "ready").length ?? 0
  const unresolvedReportableIssues = issues.filter((issue) => issue.reportable).length
  const latestRun = runs[0]
  const nextIssue = highPriorityIssues[0] ?? issues[0]
  const nextAction = nextIssue
    ? { label: "Resolve priority issue", href: `/issues/${nextIssue.id}`, detail: `${nextIssue.title} is blocking clean client proof.` }
    : dueChecks[0]
      ? { label: "Run due checks", href: "/checks", detail: `${dueChecks.length} check${dueChecks.length === 1 ? "" : "s"} should run before the next client report.` }
      : reportReadyCount
        ? { label: "Review ready reports", href: "/reports", detail: `${reportReadyCount} report${reportReadyCount === 1 ? " is" : "s are"} ready for client review or delivery.` }
        : { label: "Open reports", href: "/reports", detail: "No urgent issues. Keep the proof loop current for retained clients." }

  return (
    <section className="flex flex-col gap-4">
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>Today&apos;s action plan</CardTitle>
          <CardDescription>Work the queue in the order that protects client trust and report readiness.</CardDescription>
          <CardAction>
            <ButtonLink href={nextAction.href} size="sm">
              {nextAction.label}
              <IconArrowRight data-icon="inline-end" />
            </ButtonLink>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <SummaryTile label="Priority issues" value={highPriorityIssues.length || issues.length} />
          <SummaryTile label="Checks due" value={dueChecks.length} />
          <SummaryTile label="Ready reports" value={reportReadyCount} />
          <SummaryTile label="Last run" value={latestRun ? latestRun.status : "n/a"} />
        </CardContent>
        <CardFooter className="border-t border-border pt-4">
          <p className="text-sm leading-6 text-muted-foreground">{nextAction.detail}</p>
        </CardFooter>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        {issues.length ? (
          <IssueListCard core={core} issues={issues} full />
        ) : (
          <NoIssuesActionCard core={core} dueChecksCount={dueChecks.length} readyReportsCount={reportReadyCount} />
        )}
        <div className="flex flex-col gap-4">
          <Card className="border-border bg-muted/20">
            <CardHeader>
              <CardTitle>Due checks</CardTitle>
              <CardDescription>Run due checks before reporting so evidence is current.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {dueChecks.length ? dueChecks.slice(0, 5).map((check) => {
                const workflow = core.data?.workflows.find((item) => item.id === check.workflowId)
                const client = workflow ? core.data?.clients.find((item) => item.id === workflow.clientId) : null

                return (
                  <div key={check.id} className="rounded-lg border border-destructive/30 bg-background/60 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{workflow?.name ?? check.name}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{client?.name ?? "Client"} · due {check.nextRunAt ? formatDate(check.nextRunAt) : "now"}</p>
                      </div>
                      <Badge variant="destructive">Due</Badge>
                    </div>
                  </div>
                )
              }) : (
                <p className="rounded-lg border border-border bg-background/45 p-3 text-sm text-muted-foreground">
                  No due checks right now.
                </p>
              )}
              <ButtonLink href="/checks" variant="outline" size="sm">
                Open checks
              </ButtonLink>
            </CardContent>
          </Card>

          <Card className="border-border bg-muted/20">
            <CardHeader>
              <CardTitle>Report readiness</CardTitle>
              <CardDescription>Keep unresolved client-facing issues out of monthly proof.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <SummaryTile label="Ready to send" value={reportReadyCount} />
              <SummaryTile label="Reportable issues open" value={unresolvedReportableIssues} />
              <ButtonLink href="/reports" variant="outline" size="sm">
                Open reports
              </ButtonLink>
            </CardContent>
          </Card>

          <Card className="border-border bg-muted/20">
            <CardHeader>
              <CardTitle>Recent check runs</CardTitle>
              <CardDescription>Latest proof signals from monitored workflows.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {runs.length ? runs.slice(0, 5).map((run) => {
                const workflow = core.data?.workflows.find((item) => item.id === run.workflowId)
                return (
                  <div key={run.id} className="rounded-lg border border-border bg-background/45 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{workflow?.name ?? "Workflow check"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{formatDate(run.createdAt)}</p>
                      </div>
                      <Badge variant={statusVariant(run.status)}>{checkStatusLabel(run.status)}</Badge>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {run.errorMessage || run.safeResponseSummary || "Stored run evidence."}
                    </p>
                  </div>
                )
              }) : (
                <p className="rounded-lg border border-border bg-background/45 p-3 text-sm text-muted-foreground">
                  No check runs yet.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </section>
  )
}

function NoIssuesActionCard({
  core,
  dueChecksCount,
  readyReportsCount,
}: {
  core: Core
  dueChecksCount: number
  readyReportsCount: number
}) {
  const workflows = core.data?.workflows.filter((workflow) => !workflow.archivedAt) ?? []
  const reports = core.data?.reports ?? []
  const action = readyReportsCount
    ? { label: "Review ready reports", href: "/reports", detail: "No unresolved issues are blocking client-ready proof." }
    : dueChecksCount
      ? { label: "Run due checks", href: "/checks", detail: "Refresh the evidence before preparing the next report." }
      : reports.length
        ? { label: "Open report history", href: "/reports", detail: "Use existing proof while the issue queue is clear." }
        : workflows.length
          ? { label: "Generate first report", href: "/reports", detail: "Monitoring exists. Convert the latest check evidence into client proof." }
          : { label: "Start guided setup", href: "/onboarding", detail: "Connect the first client workflow to begin the maintenance loop." }

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>No unresolved issues</CardTitle>
        <CardDescription>Your queue is clear. Keep the proof loop moving with the next useful action.</CardDescription>
        <CardAction>
          <ButtonLink href={action.href} size="sm">
            {action.label}
            <IconArrowRight data-icon="inline-end" />
          </ButtonLink>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <SummaryTile label="Monitored workflows" value={workflows.length} />
        <SummaryTile label="Ready reports" value={readyReportsCount} />
        <SummaryTile label="Due checks" value={dueChecksCount} />
      </CardContent>
      <CardFooter className="border-t border-border pt-4">
        <p className="text-sm leading-6 text-muted-foreground">{action.detail}</p>
      </CardFooter>
    </Card>
  )
}

function IssueListCard({ core, issues, full }: { core: Core; issues: Issue[]; full?: boolean }) {
  const unresolvedCount = issues.filter((issue) => !["resolved", "ignored"].includes(issue.status)).length
  const resolvedCount = issues.filter((issue) => issue.status === "resolved").length
  if (!issues.length) {
    return (
      <NotFoundEmpty
        title="No issues"
        description="Failed or degraded checks will create deduped issues here."
        action={<AddWorkflowDialog core={core} triggerLabel="Add workflow" />}
      />
    )
  }
  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>{full ? "Assurance queue" : "Linked issues"}</CardTitle>
        <CardDescription>Record the repair, then require a newer passing run before an issue becomes resolved.</CardDescription>
        <CardAction>
          <div className="flex gap-2">
            <Badge variant={unresolvedCount ? "destructive" : "secondary"}>{unresolvedCount} unresolved</Badge>
            <Badge variant="outline">{resolvedCount} resolved</Badge>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {issues.map((issue) => (
          <IssueDetailCard key={issue.id} core={core} issue={issue} compact={!full} />
        ))}
      </CardContent>
    </Card>
  )
}

function IssueDetailCard({ core, issue, compact }: { core: Core; issue: Issue; compact?: boolean }) {
  const workflow = core.data?.workflows.find((item) => item.id === issue.workflowId)
  const client = core.data?.clients.find((item) => item.id === issue.clientId)
  const sourceRun = core.data?.checkRuns.find((run) => run.id === issue.checkRunId)
  const verificationRun = core.data?.checkRuns.find((run) => run.id === issue.verificationRunId)
  const notes = core.data?.issueNotes.filter((note) => note.issueId === issue.id) ?? []
  const memberships = core.data?.memberships ?? []
  const ownerName = issue.ownerUserId ? userDisplayName(core, issue.ownerUserId) : "Unassigned"
  const isResolved = issue.status === "resolved"
  const reportSafeNotes = notes.filter((item) => item.reportSafe)
  const [note, setNote] = useState(issue.resolutionNote || "")
  const [activityNote, setActivityNote] = useState("")
  const [activityNoteReportSafe, setActivityNoteReportSafe] = useState(false)
  const [busyAction, setBusyAction] = useState("")
  const [actionMessage, setActionMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null)

  async function runIssueAction(action: string, successMessage: string, callback: () => Promise<unknown>) {
    setBusyAction(action)
    setActionMessage(null)
    try {
      await callback()
      setActionMessage({ tone: "success", text: successMessage })
    } catch (error) {
      setActionMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Issue update could not be saved.",
      })
    } finally {
      setBusyAction("")
    }
  }

  function addNote() {
    if (!activityNote.trim()) return
    const body = activityNote
    const reportSafe = activityNoteReportSafe
    void runIssueAction("note", reportSafe ? "Report-safe note added." : "Internal note added.", async () => {
      await core.createIssueNote(issue.id, body, reportSafe)
      setActivityNote("")
      setActivityNoteReportSafe(false)
    })
  }

  return (
    <div className="rounded-lg border border-border bg-background/45 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium">{issue.title}</p>
          <p className="text-sm text-muted-foreground">{client?.name} · {workflow?.name}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge>
          <Badge variant={issue.severity === "high" || issue.severity === "critical" ? "destructive" : "outline"}>{issue.severity}</Badge>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{issue.description}</p>
      <div className={cn(
        "mt-3 rounded-lg border p-3",
        isResolved ? "border-primary/30 bg-primary/5" : "border-border bg-muted/20"
      )}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium">
              {isResolved
                ? "Repair verified by a passing run"
                : issue.status === "in_review"
                  ? "Repair recorded — verification pending"
                  : "Repair still needed"}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {isResolved
                ? issue.resolutionNote || issue.reportSafeSummary || "Resolved. Add a stronger client-safe note if this should appear in the next report."
                : issue.status === "in_review"
                  ? "Run the source check now. Only a newer passing result will resolve this issue."
                  : "Record a client-safe repair note first, then rerun the source check to verify it."}
            </p>
          </div>
          <Badge variant={isResolved ? "secondary" : "outline"}>
            {isResolved ? "Report-safe" : `${reportSafeNotes.length} report-safe notes`}
          </Badge>
        </div>
      </div>
      {!compact ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested action</p>
          <p className="mt-1 text-sm">{issue.suggestedAction || "Review the source run, rerun the check, and add a client-safe resolution note before closing."}</p>
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 md:grid-cols-5">
        <SummaryTile label="Occurrences" value={issue.occurrenceCount} />
        <SummaryTile label="Source run" value={sourceRun ? sourceRun.status : "n/a"} />
        <SummaryTile label="HTTP" value={sourceRun?.statusCode ?? "n/a"} />
        <SummaryTile label="Verification" value={verificationRun ? `${verificationRun.status} · ${formatDate(verificationRun.completedAt)}` : "Pending"} />
        <SummaryTile label="Owner" value={ownerName} />
      </div>
      {!compact ? (
        <>
          <Separator className="my-4" />
          <FieldGroup>
            <div className="grid gap-3 md:grid-cols-2">
              <Field>
                <FieldLabel>Owner</FieldLabel>
                <NativeSelect
                  value={issue.ownerUserId}
                  onChange={(event) => {
                    const ownerUserId = event.target.value
                    void runIssueAction("owner", "Issue owner updated.", () => core.updateIssue(issue.id, { ownerUserId }))
                  }}
                  disabled={!!busyAction}
                >
                  {memberships.map((membership) => (
                    <NativeSelectOption key={membership.id} value={membership.userId}>
                      {userDisplayName(core, membership.userId)} · {membership.role}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <div className="flex items-center justify-between rounded-lg border border-border bg-background/45 p-3">
                <div>
                  <p className="text-sm font-medium">Report inclusion</p>
                  <p className="text-xs text-muted-foreground">{issue.reportable ? "Client reportable" : "Internal only"}</p>
                </div>
                <Switch
                  aria-label="Include issue in client reports"
                  checked={issue.reportable}
                  onCheckedChange={(checked) => {
                    void runIssueAction("reportable", checked ? "Issue will be included in client reports." : "Issue moved to internal-only reporting.", () =>
                      core.updateIssue(issue.id, { reportable: checked })
                    )
                  }}
                  disabled={!!busyAction}
                />
              </div>
            </div>
            <Field>
              <FieldLabel htmlFor={`issue-${issue.id}-activity-note`}>Add note</FieldLabel>
              <Textarea
                id={`issue-${issue.id}-activity-note`}
                value={activityNote}
                onChange={(event) => setActivityNote(event.target.value)}
                rows={3}
                placeholder="What was changed to repair the customer journey?"
              />
              <FieldDescription>Use report-safe notes for client-facing summaries; keep internal investigation detail private.</FieldDescription>
            </Field>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-background/45 p-3">
                <Switch
                  aria-label="Mark note as report-safe"
                  checked={activityNoteReportSafe}
                  onCheckedChange={setActivityNoteReportSafe}
                />
                <span className="text-sm">Report-safe note</span>
              </div>
              <Button type="button" variant="outline" onClick={addNote} disabled={!activityNote.trim()}>
                {busyAction === "note" ? "Adding..." : "Add note"}
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor={`issue-${issue.id}-resolution-note`}>Report-safe repair note</FieldLabel>
              <Textarea
                id={`issue-${issue.id}-resolution-note`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
              />
              <FieldDescription>Describe the repair without claiming success. A newer passing source check is required before Maintain Flow marks it resolved.</FieldDescription>
            </Field>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                onClick={() => runIssueAction("repair", "Repair recorded. Rerun the source check to verify recovery.", () => core.recordRepair(issue.id, note))}
                disabled={issue.status === "resolved" || !!busyAction || !note.trim()}
              >
                <IconCircleCheck data-icon="inline-start" />
                {busyAction === "repair"
                  ? "Recording..."
                  : issue.status === "resolved"
                    ? "Verified resolved"
                    : issue.status === "in_review"
                      ? "Update repair note"
                      : "Record repair"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => workflow && runIssueAction("rerun", "Source check reran and stored the latest result.", () => core.runCheck(workflow.id))}
                disabled={!workflow || !!busyAction}
              >
                <IconPlayerPlay data-icon="inline-start" />
                {busyAction === "rerun" ? "Rerunning..." : "Rerun source check"}
              </Button>
              <Button
                type="button"
                variant={issue.status === "snoozed" ? "default" : "outline"}
                onClick={() => runIssueAction("snooze", "Issue snoozed for 7 days.", () =>
                  core.updateIssue(issue.id, { status: "snoozed", snoozedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
                )}
                disabled={!!busyAction}
              >
                Snooze
              </Button>
              <Button
                type="button"
                variant={issue.status === "ignored" ? "default" : "outline"}
                onClick={() => runIssueAction("ignore", "Issue ignored and removed from client reporting.", () => core.updateIssue(issue.id, { status: "ignored", reportable: false }))}
                disabled={!!busyAction}
              >
                Ignore
              </Button>
            </div>
            {actionMessage ? (
              <FieldDescription className={actionMessage.tone === "error" ? "text-destructive" : ""}>
                {actionMessage.text}
              </FieldDescription>
            ) : null}
            {notes.length ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Notes</p>
                {notes.map((item) => (
                  <div key={item.id} className="rounded-md border border-border bg-muted/20 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
                      <Badge variant={item.reportSafe ? "secondary" : "outline"}>{item.reportSafe ? "Report-safe" : "Internal"}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.body}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </FieldGroup>
        </>
      ) : (
        <ButtonLink href={`/issues/${issue.id}`} variant="outline" size="sm" className="mt-3">Open issue</ButtonLink>
      )}
    </div>
  )
}

function ReportGenerateCard({ core, compact = false }: { core: Core; compact?: boolean }) {
  const clients = core.data?.clients.filter((client) => !client.archivedAt) ?? []
  const defaultPeriod = currentMonthToDate()
  const today = dateInputValue()
  const [clientId, setClientId] = useState(clients[0]?.id ?? "")
  const [periodStart, setPeriodStart] = useState(defaultPeriod.periodStart)
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.periodEnd)
  const [periodError, setPeriodError] = useState<{ field: "periodStart" | "periodEnd"; message: string } | null>(null)
  const [generateError, setGenerateError] = useState("")
  const [limitNotice, setLimitNotice] = useState<BillingLimitNotice | null>(null)
  const [generatedReportId, setGeneratedReportId] = useState("")
  const [generating, setGenerating] = useState(false)
  const reportEvidenceError = useMemo(() => {
    const periodValidation = validateReportPeriod({ periodStart, periodEnd }, today)
    const client = core.data?.clients.find((item) => item.id === clientId && !item.archivedAt)
    if (periodValidation || !client) return ""

    const metrics = aggregateReportMetrics({
      client,
      workflows: core.data?.workflows ?? [],
      checkRuns: core.data?.checkRuns ?? [],
      issues: core.data?.issues ?? [],
      periodStart,
      periodEnd,
    })
    return reportGenerationEvidenceError(metrics)
  }, [clientId, core.data?.checkRuns, core.data?.clients, core.data?.issues, core.data?.workflows, periodEnd, periodStart, today])

  async function generate() {
    const validation = validateReportPeriod({ periodStart, periodEnd }, today)
    if (validation) {
      setPeriodError(validation)
      setGenerateError("")
      return
    }

    setPeriodError(null)
    setGenerateError("")
    setGeneratedReportId("")
    setGenerating(true)
    try {
      const nextDatabase = await core.generateReport({ clientId, periodStart, periodEnd })
      const created = nextDatabase.reports.find((report) =>
        report.clientId === clientId &&
        report.periodStart === periodStart &&
        report.periodEnd === periodEnd
      )
      setGeneratedReportId(created?.id ?? "")
    } catch (error) {
      const notice = billingLimitNoticeFromError(error)
      if (notice) {
        setLimitNotice(notice)
      }
      setGenerateError(error instanceof Error ? error.message : "Could not generate the report.")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <>
      <Card className="border-border bg-muted/20">
        <CardHeader>
          <CardTitle>Generate report</CardTitle>
          <CardDescription>
            {compact
              ? "Create another selected-client report."
              : "Reports aggregate current UTC month-to-date evidence. Historical rebuilds stay disabled until audit history is available."}
          </CardDescription>
        </CardHeader>
        <CardContent>
        <FieldGroup>
          <Field>
            <FieldLabel>Client</FieldLabel>
            <NativeSelect value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <NativeSelectOption value="">Select client</NativeSelectOption>
              {clients.map((client) => <NativeSelectOption key={client.id} value={client.id}>{client.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field data-invalid={periodError?.field === "periodStart"}>
            <FieldLabel>Period start</FieldLabel>
            <Input type="date" value={periodStart} min={defaultPeriod.periodStart} max={periodEnd || today} disabled onChange={(event) => setPeriodStart(event.target.value)} />
            <FieldError>{periodError?.field === "periodStart" ? periodError.message : ""}</FieldError>
          </Field>
          <Field data-invalid={periodError?.field === "periodEnd"}>
            <FieldLabel>Period end</FieldLabel>
            <Input type="date" value={periodEnd} min={periodStart} max={today} disabled onChange={(event) => setPeriodEnd(event.target.value)} />
            <FieldError>{periodError?.field === "periodEnd" ? periodError.message : ""}</FieldError>
          </Field>
          <Button type="button" disabled={!clientId || !!reportEvidenceError || generating} onClick={generate}>
            <IconReportAnalytics data-icon="inline-start" />
            {generating ? "Generating..." : "Generate client report"}
          </Button>
          {!clients.length ? (
            <FieldDescription>
              Add a client and at least one workflow check before generating the first client-ready report.
            </FieldDescription>
          ) : !clientId ? (
            <FieldDescription>Select the client whose workflow evidence should appear in this report.</FieldDescription>
          ) : reportEvidenceError ? (
            <FieldDescription>{reportEvidenceError}</FieldDescription>
          ) : null}
          {generatedReportId ? (
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <p className="text-sm font-medium">Report generated from stored client data.</p>
              <p className="mt-1 text-xs text-muted-foreground">Preview the client-safe narrative, evidence, readiness, and PDF export before sending.</p>
              <ButtonLink href={`/reports/${generatedReportId}`} size="sm" variant="outline" className="mt-3">
                Preview report
              </ButtonLink>
            </div>
          ) : null}
          {generateError ? <FieldDescription className="text-destructive">{generateError}</FieldDescription> : null}
        </FieldGroup>
        </CardContent>
      </Card>
      <PlanLimitDialog
        core={core}
        notice={limitNotice}
        open={!!limitNotice}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setLimitNotice(null)
          }
        }}
      />
    </>
  )
}

function ReportsTable({ core }: { core: Core }) {
  const reports = core.data?.reports ?? []
  if (!reports.length) {
    return (
      <NotFoundEmpty
        title="No reports generated"
        description="Use the report generator on this page once a client has workflow evidence."
        action={false}
      />
    )
  }
  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Report history</CardTitle>
        <CardDescription>Drafts and ready reports are stored from real selected-client data.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 lg:hidden">
          {reports.map((report) => {
            const client = core.data?.clients.find((item) => item.id === report.clientId)
            return (
              <div key={report.id} className="rounded-lg border border-border bg-background/45 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{client?.name ?? "Unknown client"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDateRange(report.periodStart, report.periodEnd)}</p>
                  </div>
                  <Badge variant={report.status === "ready" && !report.staleAt ? "secondary" : "outline"}>{reportDisplayStatus(report)}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <SummaryTile label="Checks" value={report.metrics.checksRun} />
                  <SummaryTile label="Pass rate" value={`${report.metrics.passRate}%`} />
                  <SummaryTile label="Resolved" value={report.metrics.issuesResolved} />
                  <SummaryTile label="Evidence" value={core.data?.reportItems.filter((item) => item.reportId === report.id && item.snapshotVersion === report.snapshotVersion).length ?? 0} />
                </div>
                <ButtonLink href={`/reports/${report.id}`} size="sm" variant="outline" className="mt-3 w-full">
                  {report.status === "ready" && !report.staleAt ? "Review ready report" : "Review report"}
                </ButtonLink>
              </div>
            )
          })}
        </div>
        <div className="hidden overflow-x-auto lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Checks</TableHead>
                <TableHead>Pass rate</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => {
                const client = core.data?.clients.find((item) => item.id === report.clientId)
                const evidenceCount = core.data?.reportItems.filter(
                  (item) => item.reportId === report.id && item.snapshotVersion === report.snapshotVersion
                ).length ?? 0
                return (
                  <TableRow key={report.id}>
                    <TableCell>{client?.name ?? "Unknown"}</TableCell>
                    <TableCell>{formatDateRange(report.periodStart, report.periodEnd)}</TableCell>
                    <TableCell><Badge variant={report.status === "ready" && !report.staleAt ? "secondary" : "outline"}>{reportDisplayStatus(report)}</Badge></TableCell>
                    <TableCell>{report.metrics.checksRun}</TableCell>
                    <TableCell>{report.metrics.passRate}%</TableCell>
                    <TableCell>{evidenceCount}</TableCell>
                    <TableCell>
                      <ButtonLink href={`/reports/${report.id}`} size="sm" variant={report.status === "ready" && !report.staleAt ? "default" : "outline"}>
                        {report.staleAt ? "Refresh" : "Review"}
                      </ButtonLink>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function ReportPreviewCard({ core, report }: { core: Core; report: Report }) {
  const client = core.data?.clients.find((item) => item.id === report.clientId)
  const preparedReport = core.data?.reports.find((item) => item.id === report.id) ?? report
  const reportItems = core.data?.reportItems.filter(
    (item) => item.reportId === report.id && item.snapshotVersion === preparedReport.snapshotVersion
  ) ?? []
  const reportViewModel = useMemo(() => {
    if (!core.database || !core.agency) return null
    try {
      return createReportViewModel({ database: core.database, agency: core.agency, report: preparedReport })
    } catch {
      return null
    }
  }, [core.agency, core.database, preparedReport])
  const scorecard = reportViewModel?.scorecard ?? preparedReport.metrics
  const evidenceItems = reportViewModel?.evidenceItems ?? reportItems
  const reportSummary = reportViewModel?.summary ?? preparedReport.narrative
  const [draftNarrative, setDraftNarrative] = useState(preparedReport.narrative)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState("")
  const [copyStatus, setCopyStatus] = useState("")
  const [copyError, setCopyError] = useState("")
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [refreshingEvidence, setRefreshingEvidence] = useState(false)
  const [narrativeError, setNarrativeError] = useState("")
  const narrativeChanged = draftNarrative !== preparedReport.narrative
  const reportFilename = `${client?.slug ?? "client"}-maintain-flow-report.pdf`
  const blockedReadiness = Object.entries(preparedReport.readiness).filter(
    ([key, value]) => key !== "pdfGenerated" && !value
  )
  const snapshotCurrent = reportSnapshotIsReadyForUse(preparedReport)
  const clientReady = snapshotCurrent && blockedReadiness.length === 0
  const currentReportPeriod = currentMonthToDate()
  const historicalRefreshBlocked =
    preparedReport.periodStart !== currentReportPeriod.periodStart
    || preparedReport.periodEnd !== currentReportPeriod.periodEnd
  const pdfPrepared = Boolean(
    snapshotCurrent &&
    preparedReport.pdfSnapshotVersion === preparedReport.snapshotVersion &&
    (preparedReport.pdfDataUrl || preparedReport.pdfStoragePath)
  )

  useEffect(() => {
    setDraftNarrative(preparedReport.narrative)
  }, [preparedReport.narrative])

  async function prepareDownload() {
    setExporting(true)
    setExportError("")
    try {
      await core.prepareReportDownload(preparedReport.id)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Report export failed.")
    } finally {
      setExporting(false)
    }
  }

  async function refreshEvidence() {
    setRefreshingEvidence(true)
    setExportError("")
    try {
      await core.refreshReport(preparedReport.id)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Could not refresh report evidence.")
    } finally {
      setRefreshingEvidence(false)
    }
  }

  async function downloadStoredReport() {
    setExporting(true)
    setExportError("")
    try {
      await downloadReportPdfFromApi(preparedReport.id, reportFilename)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Report download failed.")
    } finally {
      setExporting(false)
    }
  }

  async function saveNarrative() {
    setSavingNarrative(true)
    setNarrativeError("")
    try {
      await core.saveReportNarrative(preparedReport.id, draftNarrative)
    } catch (error) {
      setNarrativeError(error instanceof Error ? error.message : "Could not save the report narrative.")
    } finally {
      setSavingNarrative(false)
    }
  }

  async function copyClientEmailDraft() {
    setCopyStatus("")
    setCopyError("")
    try {
      const draft = buildReportDeliveryDraft({
        agencyName: core.agency?.name ?? "Maintain Flow",
        senderName: core.agency?.reportSenderName || core.user?.name || core.user?.email || "the team",
        clientName: client?.name ?? "Client",
        periodLabel: formatDateRange(preparedReport.periodStart, preparedReport.periodEnd),
        narrative: draftNarrative,
        scorecard,
        evidenceCount: evidenceItems.length,
        pdfPrepared,
      })
      await navigator.clipboard.writeText(draft)
      setCopyStatus("Client email draft copied. Attach the downloaded PDF from your own inbox.")
      trackProductEvent({
        eventName: "report_delivery_draft_copied",
        agencyId: core.agency?.id ?? null,
        metadata: {
          pdfPrepared,
          evidenceCount: evidenceItems.length,
          clientRecipientConfigured: Boolean(client?.reportRecipientEmail),
        },
      })
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : "Could not copy the client email draft.")
    }
  }

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>{client?.name ?? "Client"} journey assurance report</CardTitle>
        <CardDescription>Snapshot-bound client journey evidence for {formatDateRange(preparedReport.periodStart, preparedReport.periodEnd)}</CardDescription>
        <CardAction>
          <Badge variant={preparedReport.status === "ready" && !preparedReport.staleAt ? "secondary" : "outline"}>{reportDisplayStatus(preparedReport)}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-3 md:grid-cols-4">
          <SummaryTile label="Workflows" value={scorecard.workflowsMonitored} />
          <SummaryTile label="Checks" value={scorecard.checksRun} />
          <SummaryTile label="Pass rate" value={`${scorecard.passRate}%`} />
          <SummaryTile label="Resolved" value={scorecard.issuesResolved} />
        </div>
        {!snapshotCurrent ? (
          <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Evidence changed — this report cannot be shared yet.</p>
              <p className="mt-1 text-xs leading-5 opacity-80">
                {historicalRefreshBlocked
                  ? "Historical snapshots cannot be rebuilt without transition history. Keep this snapshot as-is and generate a current-month report."
                  : "Refresh the snapshot, review the latest checks and issues, then prepare a new PDF."}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={refreshEvidence} disabled={refreshingEvidence || historicalRefreshBlocked}>
              {historicalRefreshBlocked ? "Historical refresh unavailable" : refreshingEvidence ? "Refreshing..." : "Refresh report evidence"}
            </Button>
          </div>
        ) : null}
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="rounded-xl border border-border bg-background p-5 shadow-sm">
              <div className="flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Prepared for</p>
                  <h2 className="mt-1 text-2xl font-medium">{client?.name ?? "Client"}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{formatDateRange(preparedReport.periodStart, preparedReport.periodEnd)}</p>
                </div>
                <div className="text-sm text-muted-foreground sm:text-right">
                  <p>{core.agency?.name}</p>
                  <p>{core.agency?.reportSenderEmail || core.user?.email}</p>
                </div>
              </div>
              <div className="grid gap-4 py-5 md:grid-cols-3">
                <SummaryTile label="Monitored workflows" value={scorecard.workflowsMonitored} />
                <SummaryTile label="Checks run" value={scorecard.checksRun} />
                <SummaryTile label="Avg latency" value={scorecard.averageLatencyMs ? `${scorecard.averageLatencyMs}ms` : "n/a"} />
              </div>
              <p className="text-sm leading-7 text-muted-foreground whitespace-pre-wrap">{reportSummary}</p>
            </div>

            {reportViewModel ? (
              <>
                <div className="rounded-lg border border-border bg-background/45 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Workflow coverage</p>
                    <Badge variant="outline">{reportViewModel.workflowCoverage.length}</Badge>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {reportViewModel.workflowCoverage.map((workflow) => (
                      <div key={workflow.workflowId} className="rounded-md border border-border bg-muted/20 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 truncate text-sm font-medium">{workflow.name}</p>
                          <Badge variant={statusVariant(workflow.status as Workflow["status"])}>{workflow.status}</Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{workflow.method} {workflow.endpointUrl}</p>
                        <p className="mt-2 text-xs text-muted-foreground">{workflow.checksRun} checks included · health score {workflow.healthScore}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-background/45 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">Check evidence</p>
                    <Badge variant="outline">{reportViewModel.checkRuns.length}</Badge>
                  </div>
                  <div className="flex flex-col gap-2">
                    {reportViewModel.checkRuns.slice(0, 8).map((run) => (
                      <div key={run.checkRunId} className="rounded-md border border-border bg-muted/20 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium">{run.workflowName}</p>
                          <Badge variant={statusVariant(run.status as Workflow["status"])}>{checkStatusLabel(run.status)}</Badge>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          HTTP {run.statusCode ?? "n/a"} · {run.latencyMs ?? "n/a"}ms · {formatDate(run.createdAt)}
                        </p>
                      </div>
                    ))}
                    {!reportViewModel.checkRuns.length ? (
                      <NotFoundEmpty title="No check evidence" description="Run checks for this client and generate the report again." />
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-lg border border-border bg-background/45 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">Open issues</p>
                      <Badge variant="outline">{reportViewModel.issues.length}</Badge>
                    </div>
                    <div className="flex flex-col gap-2">
                      {reportViewModel.issues.length ? reportViewModel.issues.map((issue) => (
                        <div key={issue.issueId} className="rounded-md border border-border bg-muted/20 p-3">
                          <p className="text-sm font-medium">{issue.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{issue.severity} · {issue.workflowName}</p>
                        </div>
                      )) : <p className="text-sm text-muted-foreground">No reportable open issues for this period.</p>}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-background/45 p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">Recommendations</p>
                      <Badge variant="outline">{reportViewModel.recommendations.length}</Badge>
                    </div>
                    <div className="flex flex-col gap-2">
                      {reportViewModel.recommendations.map((recommendation) => (
                        <p key={recommendation} className="rounded-md border border-border bg-muted/20 p-3 text-sm leading-6 text-muted-foreground">{recommendation}</p>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            <div className="rounded-lg border border-border bg-background/45 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-sm font-medium">Evidence log</p>
                <Badge variant="outline">{evidenceItems.length} items</Badge>
              </div>
              <div className="flex flex-col gap-2">
                {evidenceItems.length ? evidenceItems.map((item) => (
                  <div key={item.id} className="rounded-md border border-border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium">{item.title}</p>
                      <Badge variant={item.reportSafe ? "secondary" : "outline"}>{item.sourceType}</Badge>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.body}</p>
                  </div>
                )) : (
                  <NotFoundEmpty title="No report evidence" description="Run checks for this client and generate the report again." />
                )}
              </div>
            </div>
          </div>

          <aside className="flex min-w-0 flex-col gap-4">
            <div className="rounded-lg border border-border bg-background/45 p-4">
              <p className="text-xs text-muted-foreground">Client readiness</p>
              <p className="mt-1 text-lg font-medium">{clientReady ? "Ready to share" : !snapshotCurrent ? "Trusted evidence required" : `${blockedReadiness.length} items need review`}</p>
              {!snapshotCurrent ? (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Refresh this report with service-issued evidence before sharing it with a client.
                </p>
              ) : blockedReadiness.length ? (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Review {blockedReadiness.map(([key]) => readinessSentenceLabel(key)).join(", ")} before sending.
                </p>
              ) : (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Narrative, evidence, and readiness checks are complete.</p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div className="rounded-lg border border-border bg-background/45 p-3">
                <p className="text-xs text-muted-foreground">Private PDF</p>
                <p className="mt-1 text-lg font-medium">{pdfPrepared ? "Prepared" : "Not prepared"}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {pdfPrepared ? "Latest export is ready for authorized download." : "Prepare after final narrative edits."}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background/45 p-3">
                <p className="text-xs text-muted-foreground">Evidence</p>
                <p className="mt-1 text-lg font-medium">{evidenceItems.length} items</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">Only report-safe workflow, check, issue, and recommendation evidence is included.</p>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/45 p-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>Draft narrative</FieldLabel>
                  <Textarea value={draftNarrative} onChange={(event) => setDraftNarrative(event.target.value)} rows={5} />
                  <FieldDescription>Keep this client-safe. Saving changes clears any prepared PDF so the next download matches the current draft.</FieldDescription>
                </Field>
                <div className="flex flex-col gap-2">
                  <Button type="button" variant="outline" onClick={() => setDraftNarrative(preparedReport.narrative)} disabled={!narrativeChanged}>
                    Reset draft
                  </Button>
                  <Button type="button" onClick={saveNarrative} disabled={!narrativeChanged || savingNarrative}>
                    <IconCircleCheck data-icon="inline-start" />
                    {savingNarrative ? "Saving..." : "Save draft narrative"}
                  </Button>
                </div>
                {narrativeError ? <FieldDescription className="text-destructive">{narrativeError}</FieldDescription> : null}
              </FieldGroup>
            </div>

            <div className="grid gap-2">
              {Object.entries(preparedReport.readiness).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/45 p-3">
                  <span className="text-sm">{readinessLabel(key)}</span>
                  <Badge variant={value ? "secondary" : "outline"}>{value ? "Ready" : "Needs review"}</Badge>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-background/45 p-4">
              <p className="mb-3 text-sm font-medium">Delivery</p>
              <p className="mb-3 text-xs leading-5 text-muted-foreground">
                Download the client-ready PDF and send it from your own inbox. Maintain Flow no longer sends report emails directly.
              </p>
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={prepareDownload}
                  disabled={exporting || narrativeChanged || !snapshotCurrent || preparedReport.status !== "ready"}
                >
                  <IconDownload data-icon="inline-start" />
                  {exporting ? "Preparing client-ready PDF" : pdfPrepared ? "Refresh client-ready PDF" : "Prepare client-ready PDF"}
                </Button>
                {pdfPrepared && preparedReport.pdfDataUrl ? (
                  <a
                    className={cn(buttonVariants())}
                    href={preparedReport.pdfDataUrl}
                    download={reportFilename}
                  >
                    <IconDownload data-icon="inline-start" />
                    Download client-ready PDF
                  </a>
                ) : null}
                {pdfPrepared && !preparedReport.pdfDataUrl && preparedReport.pdfStoragePath ? (
                  <Button type="button" onClick={downloadStoredReport} disabled={exporting}>
                    <IconDownload data-icon="inline-start" />
                    Download client-ready PDF
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={copyClientEmailDraft} disabled={!clientReady}>
                  <IconCopy data-icon="inline-start" />
                  Copy client email draft
                </Button>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {narrativeChanged ? (
                  <FieldDescription className="text-muted-foreground">Save the draft narrative before refreshing the PDF so the download matches this screen.</FieldDescription>
                ) : null}
                {!["ready", "sent"].includes(preparedReport.status) ? (
                  <FieldDescription className="text-muted-foreground">Complete report readiness before sharing this report externally.</FieldDescription>
                ) : null}
                {!pdfPrepared ? <FieldDescription className="text-muted-foreground">Prepare the PDF before sending the copied draft to a client.</FieldDescription> : null}
                {copyStatus ? <FieldDescription className="text-primary">{copyStatus}</FieldDescription> : null}
                {copyError ? <FieldDescription className="text-destructive">{copyError}</FieldDescription> : null}
                {exportError ? <FieldDescription className="text-destructive">{exportError}</FieldDescription> : null}
              </div>
            </div>
          </aside>
        </div>
      </CardContent>
    </Card>
  )
}

function RecentActivityCard({ core }: { core: Core }) {
  const events = core.data?.auditEvents.slice(0, 8) ?? []
  const fallbackEvents = buildProofEvents(core).slice(0, 8)
  const visibleEvents = events.length
    ? events.map((event) => ({
        id: event.id,
        icon: IconDatabase,
        title: `${event.entityType} ${event.action}`,
        detail: formatDate(event.createdAt),
        tone: "default" as const,
      }))
    : fallbackEvents

  return (
    <Card className="border-border bg-muted/20">
      <CardHeader>
        <CardTitle>Recent proof and fixes</CardTitle>
        <CardDescription>Latest report, issue, and check evidence from the maintenance loop.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {visibleEvents.length ? visibleEvents.map((event) => {
          const Icon = event.icon

          return (
          <div key={event.id} className="flex items-center gap-3 rounded-lg border border-border bg-background/45 p-3">
            <Icon aria-hidden className={event.tone === "destructive" ? "text-destructive" : "text-primary"} />
            <div>
              <p className="text-sm font-medium">{event.title}</p>
              <p className="text-xs text-muted-foreground">{event.detail}</p>
            </div>
          </div>
          )
        }) : (
          <NotFoundEmpty
            title="No proof yet"
            description="Add a workflow and run its first check to create report-safe proof."
            action={<ButtonLink href="/onboarding" variant="outline">Start guided setup</ButtonLink>}
          />
        )}
      </CardContent>
    </Card>
  )
}

function buildProofEvents(core: Core) {
  const data = core.data
  if (!data) return []

  const reportEvents = data.reports.map((report) => {
    const client = data.clients.find((item) => item.id === report.clientId)
    return {
      id: `report-${report.id}`,
      icon: IconReportAnalytics,
      title: `${client?.name ?? "Client"} report ${report.status}`,
      detail: `Report period ${formatDateRange(report.periodStart, report.periodEnd)}`,
      tone: "default" as const,
      createdAt: report.updatedAt,
    }
  })

  const issueEvents = data.issues.map((issue) => {
    const client = data.clients.find((item) => item.id === issue.clientId)
    const resolved = issue.status === "resolved"
    return {
      id: `issue-${issue.id}`,
      icon: resolved ? IconCircleCheck : IconAlertTriangle,
      title: `${resolved ? "Resolved" : "Open"} issue for ${client?.name ?? "client"}`,
      detail: `${issue.title} · ${formatDate(issue.updatedAt)}`,
      tone: resolved ? "default" as const : "destructive" as const,
      createdAt: issue.updatedAt,
    }
  })

  const checkEvents = data.checkRuns.slice(0, 12).map((run) => {
    const workflow = data.workflows.find((item) => item.id === run.workflowId)
    return {
      id: `run-${run.id}`,
      icon: run.status === "healthy" ? IconHeartbeat : IconAlertTriangle,
      title: `${workflow?.name ?? "Workflow"} check ${checkStatusLabel(run.status).toLowerCase()}`,
      detail: `${run.latencyMs ? `${run.latencyMs}ms` : "No latency"} · ${formatDate(run.createdAt)}`,
      tone: run.status === "healthy" ? "default" as const : "destructive" as const,
      createdAt: run.createdAt,
    }
  })

  return [...reportEvents, ...issueEvents, ...checkEvents].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-background/45 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-medium">{value}</p>
    </div>
  )
}

function LinkedList({
  title,
  items,
}: {
  title: string
  items: Array<{ label: string; detail: string; href: string }>
}) {
  return (
    <div className="rounded-lg border border-border bg-background/45 p-3">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-3 flex flex-col gap-2">
        {items.length ? items.map((item) => (
          <ButtonLink key={item.href} href={item.href} variant="ghost" size="sm" className="justify-start">
            <span className="truncate">{item.label}</span>
            <Badge variant={statusVariant(item.detail)}>{item.detail}</Badge>
          </ButtonLink>
        )) : (
          <p className="text-xs text-muted-foreground">None yet</p>
        )}
      </div>
    </div>
  )
}

function NotFoundEmpty({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode | false
}) {
  const renderedAction = action === false ? null : action ?? <ButtonLink href="/onboarding" variant="outline">Open onboarding</ButtonLink>

  return (
    <Empty className="min-h-72 border border-border bg-muted/20">
      <EmptyMedia variant="icon"><IconTool aria-hidden /></EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {renderedAction ? <EmptyContent>{renderedAction}</EmptyContent> : null}
    </Empty>
  )
}

function findClient(core: Core, entityId?: string) {
  return core.data?.clients.find((client) => client.id === entityId || client.slug === entityId)
}

function clientNameForId(core: Core, clientId: string) {
  return core.data?.clients.find((client) => client.id === clientId)?.name ?? "Selected client"
}

function findWorkflow(core: Core, entityId?: string) {
  return core.data?.workflows.find((workflow) => workflow.id === entityId)
}

function findIssue(core: Core, entityId?: string) {
  return core.data?.issues.find((issue) => issue.id === entityId)
}

function findReport(core: Core, entityId?: string) {
  return core.data?.reports.find((report) => report.id === entityId)
}

function reportSnapshotIsReadyForUse(report: Report) {
  return Boolean(
    report.snapshot &&
    reportSnapshotUsesOnlyServiceEvidence(report.snapshot) &&
    report.snapshotVersion > 0 &&
    report.snapshot.version === report.snapshotVersion &&
    report.snapshot.evidenceFingerprint === report.evidenceFingerprint &&
    !report.staleAt &&
    report.readiness.snapshotCurrent !== false
  )
}

function reportDisplayStatus(report: Report) {
  if (!reportSnapshotIsReadyForUse(report)) return "Evidence changed"
  if (report.status === "blocked") return "Needs review"
  if (report.status === "draft") return "Draft"
  if (report.status === "sent") return "Sent"
  return "Ready"
}

function workflowPassRate(runs: CheckRun[]) {
  if (!runs.length) return 0
  const healthy = runs.filter((run) => run.status === "healthy").length
  return Math.round((healthy / runs.length) * 1000) / 10
}

function workflowMatchesRegistryFilter(core: Core, workflow: Workflow, filter: WorkflowRegistryFilter, nowMs: number) {
  if (filter === "all") return true
  if (filter === "failed") return workflow.status === "failed" || workflow.status === "degraded"
  if (filter === "due") return workflowIsDue(core, workflow, nowMs)
  if (filter === "report") return workflow.reportIncluded
  if (filter === "pending") {
    return workflow.status === "pending" || workflowChecksForWorkflow(core, workflow).some((check) => check.pendingSetup)
  }
  return true
}

function workflowChecksForWorkflow(core: Core, workflow: Workflow) {
  return core.data?.checks.filter((check) => check.workflowId === workflow.id && check.agencyId === workflow.agencyId) ?? []
}

function workflowIsDue(core: Core, workflow: Workflow, nowMs: number) {
  return workflowChecksForWorkflow(core, workflow).some((check) =>
    check.enabled
    && !check.pendingSetup
    && Boolean(check.nextRunAt)
    && new Date(check.nextRunAt!).getTime() <= nowMs
  )
}

function workflowDueLabel(core: Core, workflow: Workflow, nowMs: number) {
  const checks = workflowChecksForWorkflow(core, workflow)
  if (!checks.length) return "No check"
  const activeChecks = checks.filter((check) => check.enabled && !check.pendingSetup)
  if (!activeChecks.length) return checks.some((check) => check.pendingSetup) ? "Pending setup" : "Disabled"
  const dueCount = activeChecks.filter((check) =>
    check.nextRunAt && new Date(check.nextRunAt).getTime() <= nowMs
  ).length
  if (dueCount) return dueCount === 1 ? "Due now" : `${dueCount} due now`
  const nextRunAt = activeChecks.reduce<string | null>((earliest, check) => {
    if (!check.nextRunAt) return earliest
    return !earliest || new Date(check.nextRunAt).getTime() < new Date(earliest).getTime()
      ? check.nextRunAt
      : earliest
  }, null)
  return nextRunAt ? formatDate(nextRunAt) : "Not scheduled"
}

function readinessLabel(key: string) {
  const labels: Record<string, string> = {
    clientSelected: "Client Selected",
    periodSelected: "Period Selected",
    workflowsIncluded: "Workflows Included",
    checksAvailable: "Checks Available",
    activeCheckCoverageComplete: "Active Check Coverage",
    issuesReviewed: "Issues Reviewed",
    unresolvedReportableIssuesReviewed: "Unresolved Reportable Issues Reviewed",
    latestEvidenceAcceptable: "Latest Evidence Acceptable",
    recoveryVerified: "Recovery Verified",
    exceptionsDisclosed: "Accepted Exceptions Disclosed",
    snapshotCurrent: "Evidence Snapshot Current",
    narrativeComplete: "Narrative Complete",
    pdfGenerated: "PDF Generated",
  }
  return labels[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase())
}

function readinessSentenceLabel(key: string) {
  const labels: Record<string, string> = {
    clientSelected: "client selection",
    periodSelected: "report period",
    workflowsIncluded: "included workflows",
    checksAvailable: "available checks",
    activeCheckCoverageComplete: "service-issued evidence for every active check",
    issuesReviewed: "issue review",
    unresolvedReportableIssuesReviewed: "reportable issue review",
    latestEvidenceAcceptable: "latest check evidence",
    recoveryVerified: "repair verification",
    exceptionsDisclosed: "accepted exception disclosure",
    snapshotCurrent: "current evidence snapshot",
    narrativeComplete: "report narrative",
    pdfGenerated: "PDF generation",
  }
  return labels[key] ?? readinessLabel(key).toLowerCase()
}

function userDisplayName(core: Core, userId: string) {
  if (core.user?.id === userId) {
    return core.user.name || core.user.email
  }
  const membership = core.data?.memberships.find((item) => item.userId === userId)
  if (membership) {
    return `${membership.role[0]?.toUpperCase() ?? "M"}${membership.role.slice(1)} member`
  }
  return "Unassigned"
}

function statusVariant(status: string) {
  if (["failed", "open", "high", "critical", "blocked"].includes(status)) {
    return "destructive" as const
  }
  if (["healthy", "resolved", "ready"].includes(status)) {
    return "secondary" as const
  }
  return "outline" as const
}

function checkStatusLabel(status: string) {
  return status === "skipped" ? "Inconclusive" : status
}

function workflowStatusLabel(workflow: Workflow) {
  return workflow.status === "failed" ? "Failed - review" : assuranceStatusLabel(workflow.status)
}

function assuranceStatusLabel(status: Workflow["status"]) {
  return status[0].toUpperCase() + status.slice(1)
}

function HttpStatusBadge({ statusCode }: { statusCode: number | null }) {
  const badge = httpStatusBadge(statusCode)

  return (
    <Badge variant="outline" className={cn("tabular-nums", badge.className)} title={badge.title}>
      {badge.label}
    </Badge>
  )
}

function httpStatusBadge(statusCode: number | null) {
  if (!statusCode) {
    return {
      label: "n/a",
      title: "No HTTP status code was recorded for this run.",
      className: "border-border bg-muted/60 text-muted-foreground",
    }
  }

  if (statusCode >= 200 && statusCode < 300) {
    return {
      label: `${statusCode} OK`,
      title: "Successful HTTP response.",
      className:
        "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-300",
    }
  }

  if (statusCode >= 300 && statusCode < 400) {
    return {
      label: `${statusCode} Redirect`,
      title: "Redirect HTTP response.",
      className:
        "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-300",
    }
  }

  if (statusCode >= 400 && statusCode < 500) {
    return {
      label: `${statusCode} Client`,
      title: "Client error HTTP response.",
      className:
        "border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300",
    }
  }

  if (statusCode >= 500 && statusCode < 600) {
    return {
      label: `${statusCode} Server`,
      title: "Server error HTTP response.",
      className:
        "border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300",
    }
  }

  if (statusCode >= 100 && statusCode < 200) {
    return {
      label: `${statusCode} Info`,
      title: "Informational HTTP response.",
      className:
        "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/40 dark:text-sky-300",
    }
  }

  return {
    label: String(statusCode),
    title: "Non-standard HTTP status code.",
    className: "border-border bg-muted/60 text-muted-foreground",
  }
}

function formatDate(value?: string | null) {
  if (!value) return "n/a"
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
}

function formatDateRange(start?: string | null, end?: string | null) {
  if (!start || !end) return "n/a"

  const formatter = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" })

  return `${formatter.format(new Date(start))} to ${formatter.format(new Date(end))}`
}

function buildReportDeliveryDraft({
  agencyName,
  senderName,
  clientName,
  periodLabel,
  narrative,
  scorecard,
  evidenceCount,
  pdfPrepared,
}: {
  agencyName: string
  senderName: string
  clientName: string
  periodLabel: string
  narrative: string
  scorecard: Report["metrics"]
  evidenceCount: number
  pdfPrepared: boolean
}) {
  const subject = `${clientName} journey assurance report - ${periodLabel}`
  const opening = `Hi ${clientName} team,`
  const attachmentLine = pdfPrepared
    ? "I have attached the Maintain Flow journey assurance report for the period."
    : "I will attach the Maintain Flow journey assurance report PDF before sending this."
  const summary = narrative.trim() || "The attached report summarizes monitored journeys, checks, issues, and verified repair evidence for the period."

  return [
    `Subject: ${subject}`,
    "",
    opening,
    "",
    attachmentLine,
    "",
    summary,
    "",
    `Summary: ${scorecard.workflowsMonitored} workflow${scorecard.workflowsMonitored === 1 ? "" : "s"} monitored, ${scorecard.checksRun} check run${scorecard.checksRun === 1 ? "" : "s"}, ${scorecard.passRate}% pass rate, ${scorecard.issuesResolved} issue${scorecard.issuesResolved === 1 ? "" : "s"} resolved, and ${evidenceCount} report-safe evidence item${evidenceCount === 1 ? "" : "s"} included.`,
    "",
    "The report shows what was monitored, what changed, and what still needs attention.",
    "",
    "Best,",
    senderName,
    agencyName,
  ].join("\n")
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
