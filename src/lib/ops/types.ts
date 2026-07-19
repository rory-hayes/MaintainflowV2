export type OpsHealthStatus = "healthy" | "attention" | "missing"

export type OpsProviderHealth = {
  name: string
  status: OpsHealthStatus
  detail: string
  metric: string
}

export type OpsMetric = {
  label: string
  value: string | number
  detail: string
}

export type OpsFunnelStep = {
  eventName: string
  label: string
  count: number
  dropoffFromPrevious: number | null
}

export type OpsRecentWorkflow = {
  id: string
  agencyId: string
  clientId: string
  name: string
  status: string
  reportIncluded: boolean
  lastCheckRunAt: string | null
  createdAt: string
}

export type OpsRecentJob = {
  id: string
  agencyId: string
  status: string
  checksDue: number
  checksRun: number
  failures: number
  errorMessage: string
  createdAt: string
}

export type OpsRecentProductEvent = {
  id: string
  agencyId: string | null
  userId: string | null
  eventName: string
  route: string
  createdAt: string
}

export type OpsRecentRateLimitEvent = {
  id: string
  agencyId: string | null
  userId: string | null
  scope: string
  allowed: boolean
  remaining: number
  resetAt: string | null
  createdAt: string
}

export type OpsPublicAcquisition = {
  eventsInstalled: boolean
  metricsAvailable: boolean
  eventsLast7Days: number
  pageViews: number
  ctaClicks: number
  signupPageViews: number
  ctaRate: number | null
  topRoutes: Array<{ label: string; count: number }>
  topPlacements: Array<{ label: string; count: number }>
}

export type OpsHealthResponse = {
  ok: true
  generatedAt: string
  adminEmail: string
  providers: OpsProviderHealth[]
  metrics: OpsMetric[]
  workflowStatus: Record<string, number>
  risk: {
    pendingSetupChecks: number
    overdueChecks: number
    staleWorkflows: number
    openIssues: number
    unresolvedHighRiskIssues: number
  }
  scheduler: {
    lastJobAt: string | null
    recentJobs: OpsRecentJob[]
  }
  analytics: {
    eventsInstalled: boolean
    eventsLast7Days: number
    funnel: OpsFunnelStep[]
    topRoutes: Array<{ route: string; count: number }>
    recentEvents: OpsRecentProductEvent[]
  }
  acquisition: OpsPublicAcquisition
  rateLimits: {
    eventsInstalled: boolean
    eventsLast24Hours: number
    blockedLast24Hours: number
    recentEvents: OpsRecentRateLimitEvent[]
  }
  recentWorkflows: OpsRecentWorkflow[]
}
