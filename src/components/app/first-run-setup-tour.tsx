"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  IconArrowLeft,
  IconArrowRight,
  IconCircleCheck,
  IconClipboardCheck,
  IconFileAnalytics,
  IconHeartbeat,
  IconRocket,
  IconSparkles,
} from "@tabler/icons-react"
import { useState } from "react"

type SetupTourStep = {
  title: string
  description: string
  badge: string
  icon: typeof IconRocket
  checklist: Array<{
    label: string
    detail: string
  }>
}

const setupTourSteps: SetupTourStep[] = [
  {
    title: "Confirm your agency workspace",
    description:
      "Maintain Flow keeps clients, workflows, checks, issues, resolutions, and reports inside one shared agency workspace.",
    badge: "Workspace",
    icon: IconClipboardCheck,
    checklist: [
      { label: "Agency profile", detail: "Name, slug, and shared workspace identity." },
      { label: "Report defaults", detail: "Sender name and reply inbox for client proof." },
      { label: "Team context", detail: "Everyone sees the same maintenance records." },
    ],
  },
  {
    title: "Connect the first client workflow",
    description:
      "Add a retained client, choose a public HTTPS GET endpoint, equivalent cURL, or platform import, then test and save the first monitor.",
    badge: "Monitor",
    icon: IconHeartbeat,
    checklist: [
      { label: "Client", detail: "Create or select the client boundary." },
      { label: "Workflow source", detail: "Public GET endpoint/cURL, n8n, Make, Zapier, or pending setup." },
      { label: "First check", detail: "Run once so failures become actionable issues." },
    ],
  },
  {
    title: "Turn maintenance into client proof",
    description:
      "Failed checks become issues, resolutions use report-safe notes, and reports show what changed during the period.",
    badge: "Proof",
    icon: IconFileAnalytics,
    checklist: [
      { label: "Issue queue", detail: "Triage failed or degraded checks." },
      { label: "Resolution notes", detail: "Separate internal detail from client-safe proof." },
      { label: "Reports", detail: "Prepare and download client-ready proof when evidence is ready." },
    ],
  },
]

export function FirstRunSetupTour({
  open,
  onOpenChange,
  onOpenWorkflowSetup,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenWorkflowSetup: () => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const step = setupTourSteps[stepIndex]
  const StepIcon = step.icon
  const finalStep = stepIndex === setupTourSteps.length - 1

  function goBack() {
    setStepIndex((current) => Math.max(0, current - 1))
  }

  function goNext() {
    setStepIndex((current) => Math.min(setupTourSteps.length - 1, current + 1))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto rounded-2xl p-0 shadow-2xl sm:max-w-[28rem]"
        overlayClassName="bg-black/60 supports-backdrop-filter:backdrop-blur-[2px]"
      >
        <div className="rounded-t-2xl bg-linear-to-br from-primary/10 via-background to-muted p-5 pb-4">
          <div className="relative mx-auto flex min-h-48 max-w-72 items-center justify-center">
            <div className="absolute inset-x-8 top-4 h-24 rounded-full bg-primary/10 blur-2xl" />
            <div className="relative w-full rounded-2xl border border-border bg-background/90 p-3 shadow-xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex size-12 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-xs">
                  <StepIcon aria-hidden />
                </div>
                <Badge variant="outline" className="bg-background/80">
                  {stepIndex + 1} / {setupTourSteps.length}
                </Badge>
              </div>
              <div className="flex flex-col gap-2">
                {step.checklist.map((item, index) => {
                  const rowState = index < stepIndex ? "complete" : index === stepIndex ? "active" : "pending"

                  return (
                    <div
                      key={item.label}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border border-border bg-background/70 px-3 py-1.5",
                        rowState === "active" ? "border-primary/50 bg-primary/5" : ""
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border [&>svg]:size-3",
                          rowState === "complete" ? "border-primary bg-primary text-primary-foreground" : "",
                          rowState === "active" ? "border-primary bg-background text-primary" : "",
                          rowState === "pending" ? "border-border bg-muted" : ""
                        )}
                      >
                        {rowState === "complete" ? <IconCircleCheck aria-hidden /> : null}
                        {rowState === "active" ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{item.label}</span>
                        <span className="block text-xs leading-5 text-muted-foreground">{item.detail}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-center gap-2">
            {setupTourSteps.map((item, index) => (
              <button
                key={item.title}
                type="button"
                aria-label={`Go to setup step ${index + 1}`}
                aria-current={index === stepIndex ? "step" : undefined}
                className={cn(
                  "h-2.5 rounded-full border border-border bg-muted transition-all",
                  index === stepIndex ? "w-8 border-primary bg-primary" : "",
                  index < stepIndex ? "w-2.5 border-primary bg-primary" : "",
                  index > stepIndex ? "w-2.5 hover:bg-primary/30" : ""
                )}
                onClick={() => setStepIndex(index)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <DialogHeader className="text-center">
            <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-border bg-muted/35 px-3 py-1 text-xs font-medium text-muted-foreground">
              <IconSparkles aria-hidden />
              {step.badge}
            </div>
            <DialogTitle className="text-xl leading-tight">{step.title}</DialogTitle>
            <DialogDescription className="leading-6">{step.description}</DialogDescription>
          </DialogHeader>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0}>
              <IconArrowLeft data-icon="inline-start" />
              Back
            </Button>
            {finalStep ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={onOpenWorkflowSetup}>
                  Add workflow
                  <IconArrowRight data-icon="inline-end" />
                </Button>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Finish
                </Button>
              </div>
            ) : (
              <Button type="button" onClick={goNext}>
                Next
                <IconArrowRight data-icon="inline-end" />
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
