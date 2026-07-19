export const publicMarketingRoutes = [
  "/",
  "/sign-up",
  "/security",
  "/privacy",
  "/terms",
] as const

export const publicMarketingEventNames = ["public_page_view", "signup_cta_clicked"] as const

export const signupCtaPlacements = [
  "nav_desktop",
  "nav_mobile",
  "home_hero",
  "home_pricing_free",
  "home_pricing_solo",
  "home_pricing_team",
  "home_pricing_agency",
  "home_template_lead",
  "home_template_trial",
  "home_closing",
  "footer_company",
] as const

export type PublicMarketingRoute = (typeof publicMarketingRoutes)[number]
export type PublicMarketingEventName = (typeof publicMarketingEventNames)[number]
export type SignupCtaPlacement = (typeof signupCtaPlacements)[number]

export type PublicMarketingEvent = {
  eventName: PublicMarketingEventName
  route: PublicMarketingRoute
  placement: SignupCtaPlacement | null
}

const publicRouteSet = new Set<string>(publicMarketingRoutes)
const eventNameSet = new Set<string>(publicMarketingEventNames)
const placementSet = new Set<string>(signupCtaPlacements)
const inputKeys = new Set(["eventName", "route", "placement"])
export function isPublicMarketingRoute(value: unknown): value is PublicMarketingRoute {
  return typeof value === "string" && publicRouteSet.has(value)
}

export function normalizePublicMarketingEvent(input: unknown): PublicMarketingEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null

  const value = input as Record<string, unknown>
  if (Object.keys(value).some((key) => !inputKeys.has(key))) return null
  if (typeof value.eventName !== "string" || !eventNameSet.has(value.eventName)) return null
  if (!isPublicMarketingRoute(value.route)) return null

  if (value.eventName === "public_page_view") {
    if (value.placement !== undefined && value.placement !== null) return null
    return { eventName: "public_page_view", route: value.route, placement: null }
  }

  if (typeof value.placement !== "string" || !placementSet.has(value.placement)) return null
  const placement = value.placement as SignupCtaPlacement
  if (!isValidCtaPlacement(value.route, placement)) return null

  return { eventName: "signup_cta_clicked", route: value.route, placement }
}

function isValidCtaPlacement(route: PublicMarketingRoute, placement: SignupCtaPlacement) {
  if (placement === "nav_desktop" || placement === "nav_mobile") return true
  if (placement === "footer_company") return true
  if (route === "/") return placement.startsWith("home_")
  return false
}
