"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { billingPlans, billingPriceDisplay, type BillingInterval } from "@/lib/billing/plans"
import { internalBillingPlanId, readPublicSignupIntent } from "@/lib/auth/signup-intent"
import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"
import { IconArrowRight, IconCircleCheck, IconRoute, IconShieldCheck, IconSparkles } from "@tabler/icons-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useState } from "react"
import { useEvals } from "../evals-provider"
import { EvalPage, PageHeading } from "../page-primitives"

const nextSteps = [
  { title: "Create and authorize a Project", detail: "Name the product or client site, confirm the public domain and record owner permission." },
  { title: "Check compatibility", detail: "Maintain Flow scans the public page and explains what can be evaluated before you configure fields." },
  { title: "Run the first supervised proof", detail: "Submit marked synthetic data once, review the evidence and schedule only the approved version." },
] as const

export function EvalsOnboardingPage() {
  const { workspaceId } = useEvals()
  const searchParams = useSearchParams()
  const intent = readPublicSignupIntent(searchParams)
  const requestedBillingPlanId = intent.plan ? internalBillingPlanId(intent.plan) : "free"
  const requestedPaidPlan = requestedBillingPlanId === "free" ? null : billingPlans[requestedBillingPlanId]
  const requestedInterval: BillingInterval = intent.interval ?? "monthly"
  const requestedPrice = requestedPaidPlan ? billingPriceDisplay(requestedPaidPlan, requestedInterval) : null
  const [selectedPath, setSelectedPath] = useState<"free" | "team" | null>(null)
  const [trialState, setTrialState] = useState<"idle" | "starting" | "started" | "ineligible">("idle")
  const [message, setMessage] = useState("")

  function continueFree() {
    setSelectedPath("free")
    setMessage("Free selected. You can prove one browser-only Lead form journey without adding a card.")
  }

  async function startTrial() {
    setTrialState("starting")
    setMessage("")
    try {
      const token = await getValidSupabaseAccessToken()
      if (!token) throw new Error("Sign in before starting the Team trial, or continue on Free.")
      const response = await fetch("/api/billing/team-trial", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-MaintainFlow-Workspace-Id": workspaceId },
      })
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; data?: { endsAt?: string; teamTrialEndsAt?: string }; error?: string }
      if (!response.ok || !payload.ok || !payload.data) {
        const errorMessage = payload.error || "The Team trial could not be started."
        if (response.status === 409 || /already|used|subscription|eligible/i.test(errorMessage)) {
          setTrialState("ineligible")
          setSelectedPath("team")
          setMessage(`${errorMessage} Continue with the workspace’s current plan.`)
          return
        }
        throw new Error(errorMessage)
      }
      setTrialState("started")
      setSelectedPath("team")
      const endsAt = payload.data.endsAt ?? payload.data.teamTrialEndsAt
      setMessage(endsAt ? `Team trial active until ${new Date(endsAt).toLocaleDateString("en-IE")}. No card was required.` : "The card-free 14-day Team trial is active.")
    } catch (cause) {
      setTrialState("idle")
      setMessage(cause instanceof Error ? cause.message : "The Team trial could not be started.")
    }
  }

  const selectedTemplate = selectedPath === "team" ? intent.template ?? "lead_form" : "lead_form"
  const projectSetupQuery = new URLSearchParams({ create: "1", template: selectedTemplate })
  const projectSetupHref = `/projects?${projectSetupQuery.toString()}`
  const billingQuery = new URLSearchParams({ plan: requestedBillingPlanId, interval: requestedInterval })
  if (intent.template) billingQuery.set("template", intent.template)

  return (
    <EvalPage className="max-w-6xl pt-10">
      <PageHeading title="Prove your first business journey" description="Choose a starting plan, then move straight into one authorized Project and a supervised Lead form proof." />

      <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader>
            <span className="mb-3 flex size-10 items-center justify-center rounded-md bg-blue-50 text-blue-600"><IconSparkles className="size-5" /></span>
            <CardTitle>Choose how to start</CardTitle>
            <CardDescription>The trial is optional. Both paths continue into the same first-proof flow.</CardDescription>
          </CardHeader>
          <CardContent>
            {requestedPaidPlan && intent.plan !== "team" ? (
              <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">Selected from pricing</span>
                    <span className="mt-1 block text-lg font-semibold text-slate-950">{requestedPaidPlan.name} · {requestedPrice?.amount} {requestedPrice?.suffix}</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-600">{requestedPrice?.note} Activate it in Billing, or prove one browser-only Lead form on Free first.</span>
                  </span>
                  <Button nativeButton={false} render={<Link href={`/settings/billing?${billingQuery.toString()}`} />} className="shrink-0 rounded-md bg-blue-600 hover:bg-blue-700">Activate {requestedPaidPlan.name}<IconArrowRight data-icon="inline-end" /></Button>
                </div>
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={continueFree}
                className={`rounded-lg border p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${selectedPath === "free" ? "border-blue-600 bg-blue-50/60" : "border-slate-200 hover:border-slate-300"}`}
              >
                <span className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-950">Continue on Free</span>{selectedPath === "free" ? <IconCircleCheck className="size-5 text-blue-600" /> : null}</span>
                <span className="mt-3 block text-sm leading-6 text-slate-600">Free includes one browser-only Lead form journey · 1 Project · 35 runs/month · 7-day evidence.</span>
              </button>
              <button
                type="button"
                onClick={() => void startTrial()}
                disabled={trialState === "starting" || trialState === "started" || trialState === "ineligible"}
                className={`rounded-lg border p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-default ${selectedPath === "team" ? "border-blue-600 bg-blue-50/60" : "border-slate-200 hover:border-slate-300"}`}
              >
                <span className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-950">{trialState === "starting" ? "Starting Team trial…" : trialState === "started" ? "Team trial active" : trialState === "ineligible" ? "Current plan retained" : intent.plan === "team" ? "Start selected Team trial" : "Start Team trial"}</span>{selectedPath === "team" ? <IconCircleCheck className="size-5 text-blue-600" /> : null}</span>
                <span className="mt-3 block text-sm leading-6 text-slate-600">14 days · no card · Trial signup, email proof, alerts, webhooks, live links and PDFs.</span>
              </button>
            </div>

            <p aria-live="polite" className="mt-4 min-h-6 text-sm text-slate-600">{message}</p>

            <div className="mt-6 flex flex-col gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-md text-sm leading-6 text-slate-600">Next, create the public Project boundary. Authorization and compatibility are handled before any submission.</p>
              {selectedPath ? (
                <Button nativeButton={false} render={<Link href={projectSetupHref} />} className="shrink-0 rounded-md bg-blue-600 hover:bg-blue-700">
                  Create first project <IconArrowRight data-icon="inline-end" />
                </Button>
              ) : (
                <Button disabled className="shrink-0 rounded-md">Choose a path first</Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="h-fit rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader><CardTitle>First-proof path</CardTitle><CardDescription>No brochure steps. Each stage completes real setup.</CardDescription></CardHeader>
          <CardContent>
            <ol className="space-y-6">
              {nextSteps.map((step, index) => (
                <li key={step.title} className="grid grid-cols-[32px_1fr] gap-3">
                  <span className="flex size-8 items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-xs font-semibold text-blue-700">{index + 1}</span>
                  <span><span className="block text-sm font-semibold text-slate-950">{step.title}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{step.detail}</span></span>
                </li>
              ))}
            </ol>
            <div className="mt-7 grid gap-3 border-t border-slate-200 pt-6 text-xs leading-5 text-slate-600 sm:grid-cols-2 lg:grid-cols-1">
              <span className="flex gap-2"><IconShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />No CAPTCHA or access-control bypass.</span>
              <span className="flex gap-2"><IconRoute className="mt-0.5 size-4 shrink-0 text-blue-600" />Lead forms can run no more often than hourly. Trial signup journeys no more often than every six hours.</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </EvalPage>
  )
}
