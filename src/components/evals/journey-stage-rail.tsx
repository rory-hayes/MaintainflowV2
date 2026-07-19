"use client"

import { cn } from "@/lib/utils"
import { IconAlertCircle, IconCircle, IconCircleCheck } from "@tabler/icons-react"
import type { JourneyStage } from "./types"
import { StatusLabel } from "./status-ui"

export function JourneyStageRail({
  stages,
  selectedId,
  onSelect,
}: {
  stages: JourneyStage[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="mb-6 snap-x snap-mandatory overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ol aria-label="Journey stages" className="flex min-w-max items-center px-1 lg:justify-center">
        {stages.map((stage, index) => {
          const active = stage.id === selectedId
          return (
            <li key={stage.id} className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => onSelect(stage.id)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "h-[166px] w-[198px] snap-start rounded-[9px] border bg-white p-5 text-left shadow-none outline-none transition hover:border-slate-400 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
                  active ? "border-amber-500 bg-amber-50/25" : "border-slate-300",
                )}
              >
                <span className={cn(
                  "mb-2.5 flex size-8 items-center justify-center rounded-full text-sm font-semibold",
                  stage.status === "passed" && "bg-emerald-100 text-emerald-700",
                  (stage.status === "degraded" || stage.status === "failed") && "bg-amber-100 text-amber-700",
                  (stage.status === "inconclusive" || stage.status === "cancelled" || stage.status === "not_run") && "bg-slate-100 text-slate-600",
                  (stage.status === "running" || stage.status === "queued") && "bg-blue-100 text-blue-700",
                )}>{index + 1}</span>
                <span className="block truncate text-base font-semibold tracking-[-0.015em] text-slate-950">{stage.name}</span>
                <StatusLabel status={stage.status} className="mt-2" />
                <span className="mt-2 block text-sm text-slate-700">{stage.duration ?? "—"}</span>
                {stage.threshold ? <span className="mt-0.5 block text-xs text-slate-500">{stage.threshold}</span> : null}
              </button>
              {index < stages.length - 1 ? <StageConnector status={stage.status} /> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function StageConnector({ status }: { status: JourneyStage["status"] }) {
  const passed = status === "passed"
  const alert = status === "degraded" || status === "failed"
  const Icon = passed ? IconCircleCheck : alert ? IconAlertCircle : IconCircle
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block h-px w-[89px] shrink-0",
        passed && "bg-emerald-600",
        alert && "bg-amber-600",
        !passed && !alert && "border-t border-dashed border-slate-400",
      )}
    >
      <span className={cn(
        "absolute left-1/2 top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#fbfaf7]",
        passed && "text-emerald-700",
        alert && "text-amber-700",
        !passed && !alert && "text-slate-500",
      )}>
        <Icon className="size-6" />
      </span>
    </span>
  )
}
