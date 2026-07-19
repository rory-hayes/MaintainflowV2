import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconHelpCircle,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"
import type { EvalStatus, Incident } from "./types"

const statusLabels: Record<EvalStatus, string> = {
  passed: "Passed",
  degraded: "Delayed",
  failed: "Failed",
  inconclusive: "Inconclusive",
  cancelled: "Cancelled",
  not_run: "Not run",
  queued: "Queued",
  running: "Running",
}

const statusStyles: Record<EvalStatus, string> = {
  passed: "text-emerald-700",
  degraded: "text-amber-700",
  failed: "text-red-700",
  inconclusive: "text-slate-500",
  cancelled: "text-slate-500",
  not_run: "text-slate-500",
  queued: "text-blue-700",
  running: "text-blue-700",
}

export function StatusIcon({ status, className }: { status: EvalStatus; className?: string }) {
  const Icon = status === "passed"
    ? IconCircleCheck
    : status === "degraded"
      ? IconAlertTriangle
      : status === "failed"
        ? IconX
        : status === "running" || status === "queued"
          ? IconLoader2
          : status === "inconclusive"
            ? IconHelpCircle
            : IconCircleDashed
  return <Icon aria-hidden className={cn("size-4", statusStyles[status], (status === "running" || status === "queued") && "animate-spin", className)} />
}

export function StatusLabel({
  status,
  compact = false,
  className,
}: {
  status: EvalStatus
  compact?: boolean
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", statusStyles[status], compact ? "text-xs" : "text-sm", className)}>
      <StatusIcon status={status} />
      {statusLabels[status]}
    </span>
  )
}

export function StatusPill({ status }: { status: EvalStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        status === "passed" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        status === "degraded" && "border-amber-200 bg-amber-50 text-amber-700",
        status === "failed" && "border-red-200 bg-red-50 text-red-700",
        status === "inconclusive" && "border-slate-200 bg-slate-50 text-slate-600",
        (status === "cancelled" || status === "not_run") && "border-slate-200 bg-slate-50 text-slate-600",
        status === "queued" && "border-blue-200 bg-blue-50 text-blue-700",
        status === "running" && "border-blue-200 bg-blue-50 text-blue-700",
      )}
    >
      {statusLabels[status]}
    </Badge>
  )
}

export function IncidentSeverity({ severity }: { severity: Incident["severity"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full capitalize",
        (severity === "critical" || severity === "high") && "border-red-200 bg-red-50 text-red-700",
        severity === "medium" && "border-amber-200 bg-amber-50 text-amber-700",
        severity === "low" && "border-slate-200 bg-slate-50 text-slate-600",
      )}
    >
      {severity}
    </Badge>
  )
}

export function journeyStateLabel(status: EvalStatus) {
  if (status === "passed") return "Journey healthy"
  if (status === "degraded") return "Journey degraded"
  if (status === "failed") return "Journey failed"
  if (status === "running") return "Journey running"
  if (status === "queued") return "Journey queued"
  if (status === "cancelled") return "Journey cancelled"
  if (status === "not_run") return "Journey not run"
  return "Journey inconclusive"
}
