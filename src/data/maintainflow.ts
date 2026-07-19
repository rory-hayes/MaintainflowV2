import type { Icon } from "@tabler/icons-react"
import {
  IconActivity,
  IconAlertTriangle,
  IconBuilding,
  IconChecks,
  IconDashboard,
  IconFileAnalytics,
  IconFlag,
  IconHeartbeat,
  IconSettings,
  IconUsers,
} from "@tabler/icons-react"

export type ScreenKey =
  | "overview"
  | "action-center"
  | "clients"
  | "client-detail"
  | "workflows"
  | "workflow-detail"
  | "checks"
  | "issues"
  | "issue-detail"
  | "reports"
  | "report-detail"
  | "settings"
  | "onboarding"

export type NavItem = {
  href: string
  label: string
  key: ScreenKey
  icon: Icon
}

export type ScreenSummary = {
  key: ScreenKey
  title: string
  eyebrow: string
  description: string
  primaryAction: string
  secondaryAction: string
  emptyTitle: string
  emptyDescription: string
  needed: string[]
  actions: string[]
}

export type Metric = {
  label: string
  value: string
  detail: string
  icon: Icon
}

export type DataRow = {
  id: string
  primary: string
  secondary: string
  status: string
  metric: string
  owner: string
}

export const appNavItems: NavItem[] = [
  { href: "/dashboard", label: "Overview", key: "overview", icon: IconDashboard },
  { href: "/action-center", label: "Action Center", key: "action-center", icon: IconFlag },
  { href: "/clients", label: "Clients", key: "clients", icon: IconBuilding },
  { href: "/workflows", label: "Workflows", key: "workflows", icon: IconActivity },
  { href: "/checks", label: "Checks", key: "checks", icon: IconChecks },
  { href: "/issues", label: "Issues", key: "issues", icon: IconAlertTriangle },
  { href: "/reports", label: "Reports", key: "reports", icon: IconFileAnalytics },
  { href: "/settings", label: "Settings", key: "settings", icon: IconSettings },
]

export const metrics: Metric[] = [
  {
    label: "Active clients",
    value: "4",
    detail: "Design partner workspace",
    icon: IconUsers,
  },
  {
    label: "Monitored workflows",
    value: "18",
    detail: "Public HTTPS GET health endpoints",
    icon: IconActivity,
  },
  {
    label: "Open issues",
    value: "3",
    detail: "2 reportable this month",
    icon: IconAlertTriangle,
  },
  {
    label: "Pass rate",
    value: "97.8%",
    detail: "Last 7 days demo sample",
    icon: IconHeartbeat,
  },
]

export const activationSteps = [
  { label: "Create agency workspace", done: true },
  { label: "Add first client", done: true },
  { label: "Connect first workflow", done: false },
  { label: "Run first check", done: false },
  { label: "Generate first report", done: false },
]

export const sampleRows: DataRow[] = [
  {
    id: "CL-104",
    primary: "Northstar Automations",
    secondary: "Lead enrichment agent",
    status: "Healthy",
    metric: "99.1% pass",
    owner: "Mina",
  },
  {
    id: "WF-219",
    primary: "Invoice intake health",
    secondary: "Public health endpoint for parser -> CRM journey",
    status: "Needs review",
    metric: "842ms",
    owner: "Ava",
  },
  {
    id: "ISS-318",
    primary: "CRM sync returned 401",
    secondary: "Client journey health endpoint is no longer passing",
    status: "Open",
    metric: "Reportable",
    owner: "Sam",
  },
  {
    id: "REP-042",
    primary: "June maintenance report",
    secondary: "Acme AI Systems",
    status: "Draft",
    metric: "86% ready",
    owner: "Mina",
  },
]

export const recentRuns = [
  { day: "Mon", passed: 34, failed: 1 },
  { day: "Tue", passed: 41, failed: 2 },
  { day: "Wed", passed: 38, failed: 0 },
  { day: "Thu", passed: 44, failed: 1 },
  { day: "Fri", passed: 47, failed: 2 },
  { day: "Sat", passed: 29, failed: 0 },
  { day: "Sun", passed: 31, failed: 1 },
]

export const screenSummaries: Record<ScreenKey, ScreenSummary> = {
  overview: {
    key: "overview",
    title: "Overview",
    eyebrow: "Operating home",
    description:
      "A cockpit for activation progress, workflow health, open issues, pass rate, reports due, and recent client proof.",
    primaryAction: "Add public endpoint",
    secondaryAction: "Generate sample report",
    emptyTitle: "Start the core loop",
    emptyDescription:
      "Create a client, add a customer-owned public endpoint, run a check, resolve an issue, and turn the proof into a report.",
    needed: ["Agency", "Clients", "Workflows", "Checks", "Issues", "Reports"],
    actions: ["Add client", "Add workflow", "Run check", "Open issue", "Generate report"],
  },
  "action-center": {
    key: "action-center",
    title: "Action Center",
    eyebrow: "Daily triage",
    description:
      "A focused queue for open issues, recent runs, enabled checks, readiness warnings, and report proof due.",
    primaryAction: "Review issues",
    secondaryAction: "View recent runs",
    emptyTitle: "No active maintenance work",
    emptyDescription:
      "When checks fail or report proof needs review, those items will collect here for daily triage.",
    needed: ["Open issues", "Recent check runs", "Enabled checks", "Readiness warnings"],
    actions: ["Rerun check", "Assign issue", "Snooze", "Resolve", "Mark reportable"],
  },
  clients: {
    key: "clients",
    title: "Clients",
    eyebrow: "Portfolio",
    description:
      "A dense client list with health, workflow count, open issues, report status, owner, and recent activity.",
    primaryAction: "Add client",
    secondaryAction: "Import sample client",
    emptyTitle: "No clients yet",
    emptyDescription:
      "Add the first retained client before connecting workflows or generating client-ready proof reports.",
    needed: ["Client name", "Owner", "Health", "Workflow count", "Open issues", "Report status"],
    actions: ["Add", "Edit", "Archive", "Search", "Filter", "Sort"],
  },
  "client-detail": {
    key: "client-detail",
    title: "Client detail",
    eyebrow: "One-client operations",
    description:
      "A focused client home with health stats, pass-rate trends, workflows, open issues, recent reports, and an add workflow CTA.",
    primaryAction: "Add workflow",
    secondaryAction: "Generate report",
    emptyTitle: "This client has no workflows",
    emptyDescription:
      "Connect the first workflow for this client to start monitoring and reporting retained maintenance value.",
    needed: ["Client profile", "Health stats", "Workflows", "Open issues", "Recent reports"],
    actions: ["Edit client", "Add workflow", "Run checks", "Open report", "Archive"],
  },
  workflows: {
    key: "workflows",
    title: "Workflows",
    eyebrow: "Monitoring registry",
    description:
      "A registry of automations and AI systems represented at launch by customer-approved public HTTPS GET health endpoints.",
    primaryAction: "Connect workflow",
    secondaryAction: "Use demo workflow",
    emptyTitle: "No workflows connected",
    emptyDescription:
      "Paste a public HTTPS GET endpoint or equivalent credential-free cURL command to create a workflow, structural health check, and first check run.",
    needed: ["Client", "Workflow type", "Status", "Latency", "Pass rate", "Frequency"],
    actions: ["Add", "Import", "Quick run", "Filter", "Toggle report inclusion"],
  },
  "workflow-detail": {
    key: "workflow-detail",
    title: "Workflow detail",
    eyebrow: "Deep operations",
    description:
      "Endpoint metadata, run history, issues, checks, auth summary, run-log keys, credential rotation, and report inclusion.",
    primaryAction: "Run check",
    secondaryAction: "Add health check",
    emptyTitle: "No checks on this workflow",
    emptyDescription:
      "Add a health check so Maintain Flow can track latency, expected status, assertions, and report impact.",
    needed: ["Endpoint metadata", "Checks", "Run history", "Issues", "Auth summary"],
    actions: ["Edit", "Run check", "Add check", "Rotate credentials", "Archive"],
  },
  checks: {
    key: "checks",
    title: "Checks",
    eyebrow: "QA coverage",
    description:
      "Coverage metrics, attention items, health checks, synthetic test packs, test cases, and run history.",
    primaryAction: "Add check",
    secondaryAction: "View run history",
    emptyTitle: "No checks yet",
    emptyDescription:
      "Create a health check from a workflow so the app can record pass/fail history and issue evidence.",
    needed: ["Health checks", "Synthetic packs", "Run history", "Coverage metrics"],
    actions: ["Add check", "Edit", "Run", "Filter", "Open workflow"],
  },
  issues: {
    key: "issues",
    title: "Issues",
    eyebrow: "Maintenance queue",
    description:
      "A queue for failed or degraded checks with status, severity, client, workflow, owner, notes, and reportability.",
    primaryAction: "Resolve issue",
    secondaryAction: "Rerun check",
    emptyTitle: "No open issues",
    emptyDescription:
      "Failed checks will create issues here so the team can resolve them with report-safe notes.",
    needed: ["Issue status", "Severity", "Client", "Workflow", "Source run", "Reportability"],
    actions: ["Assign", "Snooze", "Ignore", "Add note", "Resolve", "Toggle reportable"],
  },
  "issue-detail": {
    key: "issue-detail",
    title: "Issue detail",
    eyebrow: "Evidence and resolution",
    description:
      "Full evidence for a single issue with source run, occurrences, suggested action, notes, resolution, and report inclusion.",
    primaryAction: "Resolve with notes",
    secondaryAction: "Copy report-safe summary",
    emptyTitle: "No notes yet",
    emptyDescription:
      "Add internal notes and report-safe copy before closing the issue for client reporting.",
    needed: ["Source run", "Occurrences", "Safe response summary", "Notes", "Resolution"],
    actions: ["Rerun", "Add note", "Change status", "Resolve", "Toggle reportable"],
  },
  reports: {
    key: "reports",
    title: "Reports",
    eyebrow: "Client proof",
    description:
      "Monthly client reports with selected client, period, checks/issues/fixes stats, draft status, and download readiness.",
    primaryAction: "Generate draft",
    secondaryAction: "Check readiness",
    emptyTitle: "No reports generated",
    emptyDescription:
      "Generate the first monthly proof report once a client has workflows, check runs, and resolved issues.",
    needed: ["Client", "Period", "Status", "Checks", "Issues", "Fixes", "Send state"],
    actions: ["Select client", "Generate draft", "Prepare PDF", "Download PDF", "Copy summary"],
  },
  "report-detail": {
    key: "report-detail",
    title: "Report detail",
    eyebrow: "Client-safe narrative",
    description:
      "A document-style report preview with readiness, editable draft narrative, metrics, PDF controls, and a copyable client email draft.",
    primaryAction: "Generate PDF",
    secondaryAction: "Send to client",
    emptyTitle: "Report is not ready",
    emptyDescription:
      "Complete the readiness checklist before downloading a client-safe maintenance report.",
    needed: ["Readiness", "Narrative", "Metrics", "Recommendations", "PDF state"],
    actions: ["Edit draft", "Run readiness", "Generate PDF", "Download", "Copy client draft"],
  },
  settings: {
    key: "settings",
    title: "Settings",
    eyebrow: "Agency profile",
    description:
      "Agency profile, slug, plan, usage limits, billing readiness, report sender, branding defaults, and members.",
    primaryAction: "Save profile",
    secondaryAction: "Review billing",
    emptyTitle: "Settings need configuration",
    emptyDescription:
      "Add agency details, report sender defaults, and Stripe billing configuration before production rollout.",
    needed: ["Agency profile", "Slug", "Plan", "Usage", "Report sender", "Members"],
    actions: ["Update profile", "Review package limits", "Open Stripe checkout", "Manage subscription"],
  },
  onboarding: {
    key: "onboarding",
    title: "Onboarding",
    eyebrow: "First activation",
    description:
      "Create the agency workspace, add a client, choose setup method, paste a public GET endpoint or equivalent cURL, test, save, and land in the app.",
    primaryAction: "Continue setup",
    secondaryAction: "Use demo workflow",
    emptyTitle: "Set up your agency workspace",
    emptyDescription:
      "Create an agency, add a client and public endpoint monitor, run the first check, and generate report-ready proof.",
    needed: ["Agency name", "Slug", "Client", "Public GET endpoint or cURL", "Structural check settings"],
    actions: ["Create agency", "Create client", "Test connection", "Save monitor"],
  },
}

export function getScreenSummary(key: ScreenKey) {
  return screenSummaries[key]
}

export function getScreenKeyFromPath(pathname: string): ScreenKey {
  if (pathname.startsWith("/action-center")) return "action-center"
  if (pathname.startsWith("/clients/")) return "client-detail"
  if (pathname.startsWith("/clients")) return "clients"
  if (pathname.startsWith("/workflows/")) return "workflow-detail"
  if (pathname.startsWith("/workflows")) return "workflows"
  if (pathname.startsWith("/checks")) return "checks"
  if (pathname.startsWith("/issues/")) return "issue-detail"
  if (pathname.startsWith("/issues")) return "issues"
  if (pathname.startsWith("/reports/")) return "report-detail"
  if (pathname.startsWith("/reports")) return "reports"
  if (pathname.startsWith("/settings")) return "settings"
  if (pathname.startsWith("/onboarding")) return "onboarding"

  return "overview"
}
