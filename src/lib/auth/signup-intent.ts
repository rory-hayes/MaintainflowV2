export const publicSignupPlans = ["free", "solo", "team", "agency"] as const
export const publicSignupTemplates = ["lead_form", "trial_signup"] as const
export const publicSignupIntervals = ["monthly", "annual"] as const

export type PublicSignupPlan = (typeof publicSignupPlans)[number]
export type PublicSignupTemplate = (typeof publicSignupTemplates)[number]
export type PublicSignupInterval = (typeof publicSignupIntervals)[number]

type SearchParamsReader = { get(name: string): string | null }

export type PublicSignupIntent = {
  plan: PublicSignupPlan | null
  template: PublicSignupTemplate | null
  interval: PublicSignupInterval | null
}

export function readPublicSignupIntent(params: SearchParamsReader): PublicSignupIntent {
  return {
    plan: allowedValue(params.get("plan"), publicSignupPlans),
    template: allowedValue(params.get("template"), publicSignupTemplates),
    interval: allowedValue(params.get("interval"), publicSignupIntervals),
  }
}

export function onboardingPathForIntent(params: SearchParamsReader) {
  const intent = readPublicSignupIntent(params)
  const query = new URLSearchParams()
  if (intent.plan) query.set("plan", intent.plan)
  if (intent.template) query.set("template", intent.template)
  if (intent.interval) query.set("interval", intent.interval)
  const suffix = query.toString()
  return suffix ? `/onboarding?${suffix}` : "/onboarding"
}

export function signupHref(intent: { plan: PublicSignupPlan; template: PublicSignupTemplate; interval: PublicSignupInterval }) {
  const query = new URLSearchParams({
    plan: intent.plan,
    template: intent.template,
    interval: intent.interval,
  })
  return `/sign-up?${query.toString()}`
}

export function internalBillingPlanId(plan: PublicSignupPlan) {
  return plan === "solo" ? "starter" : plan === "team" ? "growth" : plan === "agency" ? "scale" : "free"
}

function allowedValue<const TValues extends readonly string[]>(value: string | null, allowed: TValues): TValues[number] | null {
  return value && allowed.includes(value) ? value as TValues[number] : null
}
