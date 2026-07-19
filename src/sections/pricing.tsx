"use client"

import { ButtonLink } from "@/components/ui/button-link"
import { billingPlans, billingPriceDisplay, publicBillingPlanIds, type BillingInterval } from "@/lib/billing/plans"
import { signupHref, type PublicSignupPlan } from "@/lib/auth/signup-intent"
import { cn } from "@/lib/utils"
import {
  IconArrowRight,
  IconCircleCheck,
  IconClock,
  IconFolder,
  IconPlayerPlay,
  IconRoute,
  IconUsers,
} from "@tabler/icons-react"
import { useState } from "react"

const paidCapabilities = ["Email proof", "Alerts", "Webhooks", "Live links", "PDF reports"] as const

export function Pricing() {
  const [interval, setInterval] = useState<BillingInterval>("monthly")

  return (
    <section id="pricing" className="border-t border-slate-200 bg-white px-5 py-20 sm:px-8 lg:px-12 lg:py-28">
      <div className="mx-auto max-w-[1440px]">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-4xl font-semibold tracking-[-0.045em] text-slate-950 sm:text-5xl">
            Start free. Upgrade when the proof becomes operational.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600">
            Free covers one browser-only Lead form journey; paid plans add Trial signup, email proof, operational alerts and client-ready reporting.
          </p>
          <div className="mt-7 inline-flex rounded-full border border-slate-200 bg-slate-50 p-1" aria-label="Billing interval">
            <button type="button" aria-pressed={interval === "monthly"} onClick={() => setInterval("monthly")} className={cn("rounded-full px-4 py-2 text-sm font-semibold transition", interval === "monthly" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800")}>Monthly</button>
            <button type="button" aria-pressed={interval === "annual"} onClick={() => setInterval("annual")} className={cn("rounded-full px-4 py-2 text-sm font-semibold transition", interval === "annual" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800")}>Annual · save 10%</button>
          </div>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {publicBillingPlanIds.map((planId) => {
            const plan = billingPlans[planId]
            const highlighted = planId === "growth"
            const limits = plan.businessEvalLimits
            const price = billingPriceDisplay(plan, interval)
            const signupPlan = publicSignupPlanForId(planId)

            return (
              <article
                key={planId}
                className={cn(
                  "relative flex min-h-[580px] flex-col border bg-white p-6",
                  highlighted ? "border-blue-600 shadow-[0_18px_55px_rgba(37,99,235,0.12)]" : "border-slate-200"
                )}
              >
                <div className="flex min-h-7 items-center justify-between gap-3">
                  <h3 className="text-xl font-semibold tracking-tight text-slate-950">{plan.name}</h3>
                  {highlighted ? <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">Most popular</span> : null}
                </div>
                <div className="mt-6 flex items-end gap-1">
                  <span className="text-4xl font-semibold tracking-[-0.05em] text-slate-950">{price.amount}</span>
                  <span className="max-w-24 pb-1 text-xs leading-4 text-slate-500">{price.suffix}</span>
                </div>
                <p className="mt-2 min-h-10 text-xs leading-5 text-slate-500">{price.note}</p>
                <p className="mt-4 min-h-20 text-sm leading-6 text-slate-600">{plan.description}</p>

                <ul className="mt-6 space-y-3 border-t border-slate-200 pt-6 text-sm text-slate-700">
                  <Capacity icon={IconFolder} label={`${formatLimit(limits.projects)} ${plural("project", limits.projects)}`} />
                  <Capacity icon={IconRoute} label={`${formatLimit(limits.journeys)} active ${plural("journey", limits.journeys)}`} />
                  <Capacity icon={IconPlayerPlay} label={`${formatLimit(limits.runsPerMonth)} runs/month`} />
                  <Capacity icon={IconClock} label={`${formatLimit(limits.evidenceRetentionDays)}-day evidence`} />
                  <Capacity icon={IconUsers} label={`${formatLimit(limits.seats)} ${plural("seat", limits.seats)}`} />
                </ul>

                <ul className="mt-6 space-y-2.5 border-t border-slate-200 pt-6 text-sm text-slate-600">
                  {planId === "free" ? (
                    <li className="flex items-start gap-2.5"><IconCircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />Browser-only Lead form</li>
                  ) : (
                    paidCapabilities.map((capability) => (
                      <li key={capability} className="flex items-start gap-2.5"><IconCircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />{capability}</li>
                    ))
                  )}
                  {plan.features.whiteLabel ? <li className="flex items-start gap-2.5"><IconCircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />White-labelled reports</li> : null}
                </ul>

                <ButtonLink
                  href={signupHref({ plan: signupPlan, template: "lead_form", interval })}
                  data-signup-cta={`home_pricing_${signupPlan}`}
                  variant={highlighted ? "default" : "outline"}
                  className={cn("mt-auto w-full border-slate-300", highlighted && "bg-blue-600 text-white hover:bg-blue-700")}
                >
                  {planId === "free" ? "Start free" : `Choose ${plan.name}`}
                  <IconArrowRight data-icon="inline-end" />
                </ButtonLink>
              </article>
            )
          })}
        </div>

        <p className="mx-auto mt-7 max-w-3xl text-center text-sm leading-6 text-slate-500">
          Every workspace can use one card-free 14-day Team trial. At expiry it returns to Free unless a paid plan is active. Runs stop at quota—there are no surprise overages.
        </p>
      </div>
    </section>
  )
}

function Capacity({ icon: Icon, label }: { icon: typeof IconFolder; label: string }) {
  return <li className="flex items-center gap-2.5"><Icon className="size-4 shrink-0 text-slate-500" /><span>{label}</span></li>
}

function formatLimit(value: number | null) {
  return value === null ? "Unlimited" : new Intl.NumberFormat("en-IE").format(value)
}

function plural(label: string, value: number | null) {
  return value === 1 ? label : `${label}s`
}

export default Pricing

function publicSignupPlanForId(planId: (typeof publicBillingPlanIds)[number]): PublicSignupPlan {
  if (planId === "starter") return "solo"
  if (planId === "growth") return "team"
  if (planId === "scale") return "agency"
  return "free"
}
