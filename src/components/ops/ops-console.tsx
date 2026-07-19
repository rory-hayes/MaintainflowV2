"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { BrandMark } from "@/components/brand/brand-mark"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonLink } from "@/components/ui/button-link"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { OpsHealthResponse, OpsHealthStatus } from "@/lib/ops/types"
import { getSupabaseAccessToken } from "@/lib/supabase/auth"
import {
  IconActivity,
  IconAlertTriangle,
  IconDatabase,
  IconExternalLink,
  IconLock,
  IconRoute,
  IconRotateClockwise,
  IconShieldCheck,
} from "@tabler/icons-react"
import { usePathname, useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"

type OpsApiError = {
  ok: false
  error: string
}

export function OpsConsole() {
  const router = useRouter()
  const pathname = usePathname()
  const { ready, user } = useAuth()
  const [health, setHealth] = useState<OpsHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const loadHealth = useCallback(async () => {
    if (!ready || !user) return

    const token = getSupabaseAccessToken()
    if (!token) {
      setError("The ops console requires a Supabase session.")
      setLoading(false)
      return
    }

    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/control-room/health", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const payload = (await response.json().catch(() => ({}))) as OpsHealthResponse | OpsApiError
      if (!response.ok || !payload.ok) {
        throw new Error("error" in payload ? payload.error : "Ops health could not be loaded.")
      }
      setHealth(payload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Ops health could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [ready, user])

  useEffect(() => {
    if (ready && !user) {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname ?? "/dashboard")}`)
    }
  }, [pathname, ready, router, user])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  if (!ready || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="size-2 rounded-full bg-primary" />
          Loading Maintain Flow
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/85 supports-backdrop-filter:backdrop-blur-md">
        <div className="flex flex-col gap-4 px-4 py-5 md:flex-row md:items-center md:justify-between lg:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <BrandMark />
            <Separator orientation="vertical" className="hidden h-9 md:block" />
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">Founder operations</p>
              <h1 className="text-2xl font-medium tracking-tight">Ops Monitor</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <IconLock aria-hidden />
              Hidden route
            </Badge>
            <ThemeToggle />
            <Button type="button" variant="outline" size="sm" onClick={() => void loadHealth()} disabled={loading}>
              <IconRotateClockwise data-icon="inline-start" />
              Refresh
            </Button>
            <ButtonLink href="/dashboard" size="sm" variant="outline">
              <IconExternalLink data-icon="inline-start" />
              Dashboard
            </ButtonLink>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-5 px-4 py-5 lg:px-6 lg:py-6">
        {error ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>Ops access needs attention</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {loading && !health ? <OpsLoadingState /> : null}
        {health ? <OpsHealthView health={health} /> : null}
      </div>
    </main>
  )
}

function OpsHealthView({ health }: { health: OpsHealthResponse }) {
  return (
    <>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {health.providers.map((provider) => (
          <Card key={provider.name}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{provider.name}</CardTitle>
                  <CardDescription>{provider.detail}</CardDescription>
                </div>
                <StatusBadge status={provider.status} />
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-medium tracking-tight">{provider.metric}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {health.metrics.map((metric) => (
          <Card key={metric.label}>
            <CardHeader>
              <CardTitle>{metric.label}</CardTitle>
              <CardDescription>{metric.detail}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-medium tracking-tight">{metric.value}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Core-loop risk</CardTitle>
            <CardDescription>Operational blockers that can prevent client-ready reporting.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <RiskTile label="Pending setup" value={health.risk.pendingSetupChecks} />
            <RiskTile label="Overdue checks" value={health.risk.overdueChecks} />
            <RiskTile label="Stale workflows" value={health.risk.staleWorkflows} />
            <RiskTile label="Open issues" value={health.risk.openIssues} />
            <RiskTile label="High risk" value={health.risk.unresolvedHighRiskIssues} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workflow status</CardTitle>
            <CardDescription>Current monitor state across active workflow records.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(health.workflowStatus).length ? (
              Object.entries(health.workflowStatus).map(([status, count]) => (
                <Badge key={status} variant="outline">
                  {status}: {count}
                </Badge>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No workflows found.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <AcquisitionCard health={health} />
        <FunnelCard health={health} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <RateLimitCard health={health} />
        <RecentWorkflowsCard health={health} />
      </section>

      <section>
        <SchedulerCard health={health} />
      </section>
    </>
  )
}

function AcquisitionCard({ health }: { health: OpsHealthResponse }) {
  const acquisition = health.acquisition

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Acquisition signals</CardTitle>
            <CardDescription>Identifier-free event counts from the last 7 days. Page views are not unique visitors.</CardDescription>
          </div>
          <Badge variant={acquisition.eventsInstalled ? "secondary" : "outline"}>
            {acquisition.eventsInstalled ? `${acquisition.eventsLast7Days} events` : "SQL needed"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <AcquisitionMetric label="Public page views" value={acquisition.metricsAvailable ? acquisition.pageViews : "Unknown"} />
          <AcquisitionMetric label="Signup CTA clicks" value={acquisition.metricsAvailable ? acquisition.ctaClicks : "Unknown"} />
          <AcquisitionMetric label="Signup-page views" value={acquisition.metricsAvailable ? acquisition.signupPageViews : "Unknown"} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            CTA / page view: {acquisition.metricsAvailable ? formatRate(acquisition.ctaRate) : "Unknown"}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {acquisition.topRoutes.map((route) => (
            <Badge key={route.label} variant="outline">
              <IconRoute aria-hidden />
              {route.label}: {route.count}
            </Badge>
          ))}
          {acquisition.topPlacements.map((placement) => (
            <Badge key={placement.label} variant="outline">
              {placement.label}: {placement.count}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function AcquisitionMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums">{value}</p>
    </div>
  )
}

function formatRate(value: number | null) {
  return value === null ? "—" : `${value}%`
}

function FunnelCard({ health }: { health: OpsHealthResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Activation funnel</CardTitle>
            <CardDescription>First-party events from the last 7 days.</CardDescription>
          </div>
          <Badge variant={health.analytics.eventsInstalled ? "secondary" : "outline"}>
            {health.analytics.eventsInstalled ? `${health.analytics.eventsLast7Days} events` : "SQL needed"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Drop-off</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.analytics.funnel.map((step) => (
              <TableRow key={step.eventName}>
                <TableCell>{step.label}</TableCell>
                <TableCell className="text-right tabular-nums">{step.count}</TableCell>
                <TableCell className="text-right tabular-nums">{step.dropoffFromPrevious ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex flex-wrap gap-2">
          {health.analytics.topRoutes.map((route) => (
            <Badge key={route.route} variant="outline">
              <IconRoute aria-hidden />
              {route.route}: {route.count}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function RateLimitCard({ health }: { health: OpsHealthResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Rate limits</CardTitle>
            <CardDescription>Endpoint test limiter events from the last 24 hours.</CardDescription>
          </div>
          <Badge variant={health.rateLimits.eventsInstalled ? "secondary" : "outline"}>
            {health.rateLimits.blockedLast24Hours} blocked
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scope</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Remaining</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.rateLimits.recentEvents.length ? (
              health.rateLimits.recentEvents.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>{event.scope}</TableCell>
                  <TableCell>{event.allowed ? "Allowed" : "Blocked"}</TableCell>
                  <TableCell className="text-right tabular-nums">{event.remaining}</TableCell>
                  <TableCell>{formatDateTime(event.createdAt)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No persisted rate-limit events yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function RecentWorkflowsCard({ health }: { health: OpsHealthResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <IconActivity aria-hidden className="mt-1 text-muted-foreground" />
          <div>
            <CardTitle>Recent workflows</CardTitle>
            <CardDescription>Latest attached monitors without exposing endpoint URLs.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Report</TableHead>
              <TableHead>Last run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.recentWorkflows.length ? (
              health.recentWorkflows.map((workflow) => (
                <TableRow key={workflow.id}>
                  <TableCell className="font-medium">{workflow.name}</TableCell>
                  <TableCell>{workflow.status}</TableCell>
                  <TableCell>{workflow.reportIncluded ? "Included" : "Excluded"}</TableCell>
                  <TableCell>{workflow.lastCheckRunAt ? formatDateTime(workflow.lastCheckRunAt) : "Never"}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No workflow records yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function SchedulerCard({ health }: { health: OpsHealthResponse }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <IconDatabase aria-hidden className="mt-1 text-muted-foreground" />
          <div>
            <CardTitle>Scheduler runs</CardTitle>
            <CardDescription>Recent production check-job batches stored by agency.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Due</TableHead>
              <TableHead className="text-right">Run</TableHead>
              <TableHead className="text-right">Failures</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.scheduler.recentJobs.length ? (
              health.scheduler.recentJobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>{job.status}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.checksDue}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.checksRun}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.failures}</TableCell>
                  <TableCell>{formatDateTime(job.createdAt)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No stored scheduler runs yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function RiskTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background/45 p-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-medium tracking-tight tabular-nums">{value}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: OpsHealthStatus }) {
  if (status === "healthy") {
    return (
      <Badge variant="secondary">
        <IconShieldCheck aria-hidden />
        Healthy
      </Badge>
    )
  }
  if (status === "missing") {
    return (
      <Badge variant="destructive">
        <IconAlertTriangle aria-hidden />
        Missing
      </Badge>
    )
  }
  return (
    <Badge variant="outline">
      <IconAlertTriangle aria-hidden />
      Attention
    </Badge>
  )
}

function OpsLoadingState() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-full max-w-80" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
