import { createHmac, timingSafeEqual } from "node:crypto"

import {
  billingCheckoutUnitAmountCents,
  billingPlanIds,
  billingPlans,
  businessEvalsBillingContractVersion,
  cardFreeWorkspaceTrialDays,
  getBillingInterval,
  isBillingPlanId,
  type BillingInterval,
  type BillingContractVersion,
  type BillingPlanId,
} from "./plans.ts"

type StripeSessionResponse = {
  id?: string
  url?: string
  status?: string
  payment_status?: string
  expires_at?: number
  customer?: string | { id?: string } | null
  subscription?: string | { id?: string } | null
  client_reference_id?: string | null
  metadata?: Record<string, string>
  error?: {
    message?: string
  }
}

export const stripeApiVersion = "2026-02-25.clover"

export type StripeCheckoutSessionSnapshot = {
  id: string
  url: string
  status: "open" | "complete" | "expired"
  paymentStatus: string
  expiresAt: number
  customerId: string
  subscriptionId: string
  clientReferenceId: string
  metadata: Record<string, string>
}

export type StripeCheckoutReservationIdentity = {
  id: string
  agencyId: string
  requestedByUserId: string
  planId: string
  interval: string
  providerExpiresAt: string
  stripeSessionId: string
}

export type StripeSubscriptionSnapshot = {
  id?: string
  customer?: string
  metadata?: Record<string, string>
  trial_end?: number | null
  status?: string
  items?: {
    data?: Array<{
      price?: {
        id?: string
      }
    }>
  }
}

type CheckoutSessionInput = {
  planId: BillingPlanId
  interval?: BillingInterval
  origin: string
  agencyId: string
  userId: string
  reservationId: string
  customerId?: string
  customerEmail?: string
  providerIdempotencyKey: string
  providerExpiresAt: string
}

type PortalSessionInput = {
  customerId: string
  subscriptionId?: string
  origin: string
  flow?: BillingPortalFlow
  billingContractVersion?: BillingContractVersion
}

export type BillingPortalFlow = "manage" | "subscription_update"

export function getStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() ?? ""
}

export function isStripeCustomerPortalEnabled() {
  return process.env.STRIPE_CUSTOMER_PORTAL_ENABLED?.trim().toLowerCase() === "true"
}

export function getStripeCustomerPortalConfigurationId() {
  return process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID?.trim() ?? ""
}

export function getStripePriceId(planId: BillingPlanId, interval: BillingInterval = "monthly") {
  const key = stripePriceEnvName(planId, interval)
  return process.env[key]?.trim() ?? ""
}

export function getBillingPlanIdForStripePrice(priceId: string | null | undefined): BillingPlanId | null {
  const normalizedPriceId = priceId?.trim()
  if (!normalizedPriceId) return null

  return billingPlanIds.find((planId) =>
    getStripePriceId(planId, "monthly") === normalizedPriceId
    || getStripePriceId(planId, "annual") === normalizedPriceId
    || getLegacyStripePriceId(planId, "monthly") === normalizedPriceId
    || getLegacyStripePriceId(planId, "annual") === normalizedPriceId
  ) ?? null
}

export function resolveStripeSubscriptionPlanId({
  priceId,
  metadataPlan,
  billingContractVersion,
}: {
  priceId?: string | null
  metadataPlan?: string | null
  billingContractVersion?: string | null
}): BillingPlanId | null {
  const currentPricePlan = getBillingPlanIdForStripePrice(priceId)
  if (currentPricePlan) return currentPricePlan
  const normalizedContractVersion = billingContractVersion?.trim() ?? ""
  const isGrandfatheredSubscription = normalizedContractVersion === "" || normalizedContractVersion === "legacy"
  return isGrandfatheredSubscription && metadataPlan && isBillingPlanId(metadataPlan) ? metadataPlan : null
}

export function getStripeBillingStatus() {
  const secretConfigured = Boolean(getStripeSecretKey())
  const prices = Object.fromEntries(
    billingPlanIds.map((planId) => [planId, Boolean(getStripePriceId(planId))])
  ) as Record<BillingPlanId, boolean>
  const annualPrices = Object.fromEntries(
    billingPlanIds.map((planId) => [planId, Boolean(getStripePriceId(planId, "annual"))])
  ) as Record<BillingPlanId, boolean>
  const publicPriceIds = (["starter", "growth", "scale"] as const).flatMap((planId) => [
    getStripePriceId(planId, "monthly"),
    getStripePriceId(planId, "annual"),
  ])
  const publicPricesConfigured = publicPriceIds.every(Boolean)
    && new Set(publicPriceIds).size === publicPriceIds.length
  const webhookConfigured = Boolean(getStripeWebhookSecret())
  const portalConfigured =
    secretConfigured
    && isStripeCustomerPortalEnabled()
    && Boolean(getStripeCustomerPortalConfigurationId())

  return {
    secretConfigured,
    webhookConfigured,
    prices,
    annualPrices,
    publicPricesConfigured,
    checkoutConfigured:
      secretConfigured
      && webhookConfigured
      && publicPricesConfigured
      && portalConfigured,
    portalConfigured,
    workspaceTrialDays: cardFreeWorkspaceTrialDays,
  }
}

export function checkoutConfigReason(planId: string, interval: BillingInterval = "monthly") {
  if (!isBillingPlanId(planId)) return "Select a supported Maintain Flow plan before checkout."
  if (planId === "free") return "The Free plan does not require Stripe checkout. Upgrade when you need more capacity."
  if (planId === "agency_plus") return "Agency+ is retained for existing workspaces and is not available to new self-serve customers."
  if (!getStripeSecretKey()) return "Stripe checkout needs STRIPE_SECRET_KEY before it can open."
  if (!getStripeWebhookSecret()) {
    return "Stripe checkout is disabled until signed billing webhooks are configured."
  }
  if (!isStripeCustomerPortalEnabled() || !getStripeCustomerPortalConfigurationId()) {
    return "Stripe checkout is disabled until the Customer Portal is configured for subscription management."
  }
  if (!getStripePriceId(planId, interval)) {
    return interval === "annual"
      ? "Annual billing is not available yet. Choose monthly billing."
      : `${billingPlans[planId].name} checkout is temporarily unavailable.`
  }
  const publicPriceIds = (["starter", "growth", "scale"] as const).flatMap((publicPlanId) => [
    getStripePriceId(publicPlanId, "monthly"),
    getStripePriceId(publicPlanId, "annual"),
  ])
  if (!publicPriceIds.every(Boolean) || new Set(publicPriceIds).size !== publicPriceIds.length) {
    return "Stripe checkout is disabled until all six distinct monthly and annual plan prices are configured."
  }
  if (billingCheckoutUnitAmountCents(billingPlans[planId], interval) === null) {
    return "Stripe checkout needs a supported paid Maintain Flow plan before it can open."
  }
  return ""
}

export function portalConfigReason(
  customerId?: string | null,
  flow: BillingPortalFlow = "manage",
  subscriptionId?: string | null,
  billingContractVersion?: BillingContractVersion | null
) {
  if (!getStripeSecretKey()) return "Stripe customer portal needs STRIPE_SECRET_KEY before it can open."
  if (!isStripeCustomerPortalEnabled()) return "Stripe Customer Portal is not enabled for this environment."
  if (!getStripeCustomerPortalConfigurationId()) {
    return "Stripe Customer Portal needs STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID before it can open."
  }
  if (!customerId?.trim()) return "Stripe customer portal needs a synced Stripe customer for this workspace."
  if (flow === "subscription_update" && !subscriptionId?.trim()) {
    return "Stripe subscription updates need a synced subscription for this workspace."
  }
  if (flow === "subscription_update" && billingContractVersion !== businessEvalsBillingContractVersion) {
    return "This grandfathered subscription keeps its existing price and capacity contract. Contact support before migrating it to a current plan."
  }
  return ""
}

export function isBillingPortalFlow(value: string): value is BillingPortalFlow {
  return value === "manage" || value === "subscription_update"
}

export function stripePriceEnvName(planId: BillingPlanId, interval: BillingInterval = "monthly") {
  const publicName = planId === "starter" ? "SOLO" : planId === "growth" ? "TEAM" : planId === "scale" ? "AGENCY" : planId.toUpperCase()
  return interval === "annual" ? `STRIPE_PRICE_${publicName}_ANNUAL` : `STRIPE_PRICE_${publicName}`
}

function getLegacyStripePriceId(planId: BillingPlanId, interval: BillingInterval) {
  const suffix = interval === "annual" ? "_ANNUAL" : ""
  return process.env[`STRIPE_LEGACY_PRICE_${planId.toUpperCase()}${suffix}`]?.trim()
    || process.env[`STRIPE_PRICE_${planId.toUpperCase()}${suffix}`]?.trim()
    || ""
}

export function isStripeHostedUrl(value: string | null | undefined): value is string {
  if (!value) return false

  try {
    const url = new URL(value)
    return url.protocol === "https:" && (url.hostname === "checkout.stripe.com" || url.hostname === "billing.stripe.com")
  } catch {
    return false
  }
}

export function getTrustedBillingOrigin(requestOrigin: string) {
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim()
  const candidate = configuredOrigin || (process.env.VERCEL_ENV === "production" ? "https://www.maintainflow.io" : requestOrigin)

  try {
    return new URL(candidate).origin
  } catch {
    throw new Error("Maintain Flow billing return URL is not configured correctly.")
  }
}

export async function createStripeCheckoutSession(input: CheckoutSessionInput) {
  const secretKey = getStripeSecretKey()
  const interval = getBillingInterval(input.interval)
  const plan = billingPlans[input.planId]
  const priceId = getStripePriceId(input.planId, interval)
  const checkoutAmount = billingCheckoutUnitAmountCents(plan, interval)

  const configReason = checkoutConfigReason(input.planId, interval)
  if (configReason || !secretKey || !priceId || checkoutAmount === null) throw new Error(configReason)

  const successUrl = new URL("/settings/billing", input.origin)
  successUrl.searchParams.set("billing", "checkout-success")
  successUrl.searchParams.set("session_id", "MF_CHECKOUT_SESSION_ID")
  successUrl.searchParams.set("reservation_id", input.reservationId)
  const cancelUrl = new URL("/settings/billing", input.origin)
  cancelUrl.searchParams.set("billing", "checkout-cancelled")
  cancelUrl.searchParams.set("reservation_id", input.reservationId)
  const providerExpiresAtMs = Date.parse(input.providerExpiresAt)
  if (!Number.isFinite(providerExpiresAtMs)) {
    throw new Error("Stripe checkout reservation expiry is invalid.")
  }
  if (!/^maintainflow-checkout-[a-f0-9]{64}$/.test(input.providerIdempotencyKey)) {
    throw new Error("Stripe checkout reservation idempotency is invalid.")
  }
  const successUrlWithSession = successUrl.toString().replace("MF_CHECKOUT_SESSION_ID", "{CHECKOUT_SESSION_ID}")

  const body = new URLSearchParams({
    mode: "subscription",
    success_url: successUrlWithSession,
    cancel_url: cancelUrl.toString(),
    expires_at: String(Math.floor(providerExpiresAtMs / 1000)),
    "line_items[0][quantity]": "1",
    allow_promotion_codes: "true",
    client_reference_id: input.agencyId,
    "metadata[maintainflow_plan]": input.planId,
    "metadata[maintainflow_billing_interval]": interval,
    "metadata[maintainflow_billing_contract]": businessEvalsBillingContractVersion,
    "metadata[maintainflow_agency_id]": input.agencyId,
    "metadata[maintainflow_user_id]": input.userId,
    "metadata[maintainflow_checkout_reservation_id]": input.reservationId,
    "subscription_data[metadata][maintainflow_plan]": input.planId,
    "subscription_data[metadata][maintainflow_billing_interval]": interval,
    "subscription_data[metadata][maintainflow_billing_contract]": businessEvalsBillingContractVersion,
    "subscription_data[metadata][maintainflow_agency_id]": input.agencyId,
    "subscription_data[metadata][maintainflow_user_id]": input.userId,
  })

  body.set("line_items[0][price]", priceId)

  if (input.customerId?.trim()) {
    body.set("customer", input.customerId.trim())
  } else if (input.customerEmail?.trim()) {
    body.set("customer_email", input.customerEmail.trim())
  }

  const payload = await createStripeSession(
    "https://api.stripe.com/v1/checkout/sessions",
    body,
    secretKey,
    input.providerIdempotencyKey
  )
  return parseStripeCheckoutSession(payload, true)
}

export function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? ""
}

export function assertStripeCheckoutSessionMatchesReservation(
  session: StripeCheckoutSessionSnapshot,
  reservation: StripeCheckoutReservationIdentity
) {
  const expectedProviderExpiry = Math.floor(Date.parse(reservation.providerExpiresAt) / 1000)
  if (
    session.id !== reservation.stripeSessionId
    || session.clientReferenceId !== reservation.agencyId
    || session.metadata.maintainflow_agency_id !== reservation.agencyId
    || session.metadata.maintainflow_checkout_reservation_id !== reservation.id
    || session.metadata.maintainflow_plan !== reservation.planId
    || session.metadata.maintainflow_billing_interval !== reservation.interval
    || session.metadata.maintainflow_billing_contract !== businessEvalsBillingContractVersion
    || session.metadata.maintainflow_user_id !== reservation.requestedByUserId
    || !Number.isFinite(expectedProviderExpiry)
    || Math.abs(session.expiresAt - expectedProviderExpiry) > 5
  ) {
    throw new Error("Stripe Checkout Session does not match the durable workspace reservation.")
  }
}

export function verifyStripeWebhookSignature({
  payload,
  signatureHeader,
  secret,
  toleranceSeconds = 300,
  nowMs = Date.now(),
}: {
  payload: string
  signatureHeader: string | null
  secret: string
  toleranceSeconds?: number
  nowMs?: number
}) {
  if (!secret) {
    throw new Error("Stripe webhook secret is not configured.")
  }

  const signatureParts = (signatureHeader ?? "")
    .split(",")
    .map((part) => {
      const separator = part.indexOf("=")
      return separator > 0
        ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const
        : ["", ""] as const
    })
  const timestamp = Number(signatureParts.find(([key]) => key === "t")?.[1])
  const signatures = signatureParts
    .filter(([key, value]) => key === "v1" && value)
    .map(([, value]) => value)

  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new Error("Stripe webhook signature is missing required fields.")
  }

  const ageSeconds = Math.abs(nowMs / 1000 - timestamp)
  if (ageSeconds > toleranceSeconds) {
    throw new Error("Stripe webhook signature timestamp is outside the allowed tolerance.")
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex")
  const expected = Buffer.from(expectedSignature, "hex")
  const verified = signatures.some((signature) => {
    const received = Buffer.from(signature, "hex")
    return received.length === expected.length && timingSafeEqual(received, expected)
  })

  if (!verified) {
    throw new Error("Stripe webhook signature verification failed.")
  }
}

export async function createStripeCustomerPortalSession(input: PortalSessionInput) {
  const secretKey = getStripeSecretKey()
  const configurationId = getStripeCustomerPortalConfigurationId()
  const flow = input.flow ?? "manage"
  const configReason = portalConfigReason(
    input.customerId,
    flow,
    input.subscriptionId,
    input.billingContractVersion
  )

  if (configReason || !secretKey || !configurationId) throw new Error(configReason)

  const returnUrl = new URL("/settings/billing", input.origin)
  returnUrl.searchParams.set("billing", "portal-return")

  const body = new URLSearchParams({
    configuration: configurationId,
    customer: input.customerId,
    return_url: returnUrl.toString(),
  })

  if (flow === "subscription_update") {
    body.set("flow_data[type]", "subscription_update")
    body.set("flow_data[subscription_update][subscription]", input.subscriptionId!.trim())
    body.set("flow_data[after_completion][type]", "redirect")
    body.set("flow_data[after_completion][redirect][return_url]", returnUrl.toString())
  }

  const payload = await createStripeSession(
    "https://api.stripe.com/v1/billing_portal/sessions",
    body,
    secretKey
  )

  const redirectUrl = payload.url

  if (!isStripeHostedUrl(redirectUrl)) {
    throw new Error("Stripe did not return a valid hosted customer portal URL.")
  }

  return redirectUrl
}

export async function retrieveStripeSubscription(subscriptionId: string): Promise<StripeSubscriptionSnapshot> {
  const secretKey = getStripeSecretKey()
  if (!secretKey || !subscriptionId.trim()) {
    throw new Error("Stripe subscription reconciliation is not configured.")
  }

  const response = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId.trim())}`, {
    headers: stripeAuthorizationHeaders(secretKey),
    signal: AbortSignal.timeout(5_000),
  })
  const payload = (await response.json().catch(() => ({}))) as StripeSubscriptionSnapshot & StripeSessionResponse

  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || "Stripe could not reconcile the current subscription state.")
  }

  return payload
}

export async function retrieveStripeCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionSnapshot> {
  const secretKey = getStripeSecretKey()
  if (!secretKey || !sessionId.trim()) {
    throw new Error("Stripe checkout reconciliation is not configured.")
  }
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId.trim())}`, {
    headers: stripeAuthorizationHeaders(secretKey),
    signal: AbortSignal.timeout(5_000),
  })
  const payload = (await response.json().catch(() => ({}))) as StripeSessionResponse
  if (!response.ok) {
    throw new Error(payload.error?.message || "Stripe could not reconcile the Checkout Session.")
  }
  return parseStripeCheckoutSession(payload, false)
}

export async function expireStripeCheckoutSession(sessionId: string): Promise<StripeCheckoutSessionSnapshot> {
  const secretKey = getStripeSecretKey()
  if (!secretKey || !sessionId.trim()) {
    throw new Error("Stripe checkout expiry is not configured.")
  }
  const response = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId.trim())}/expire`,
    {
      method: "POST",
      headers: {
        ...stripeAuthorizationHeaders(secretKey),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(5_000),
    }
  )
  const payload = (await response.json().catch(() => ({}))) as StripeSessionResponse
  if (!response.ok) {
    throw new Error(payload.error?.message || "Stripe could not expire the previous Checkout Session.")
  }
  return parseStripeCheckoutSession(payload, false)
}

async function createStripeSession(endpoint: string, body: URLSearchParams, secretKey: string, idempotencyKey?: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": stripeApiVersion,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
  })
  const payload = (await response.json().catch(() => ({}))) as StripeSessionResponse

  if (!response.ok) {
    throw new Error(payload.error?.message || "Stripe could not create the hosted billing session.")
  }

  return payload
}

function stripeAuthorizationHeaders(secretKey: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    "Stripe-Version": stripeApiVersion,
  }
}

function parseStripeCheckoutSession(payload: StripeSessionResponse, requireHostedUrl: boolean): StripeCheckoutSessionSnapshot {
  const id = payload.id?.trim() ?? ""
  const redirectUrl = payload.url?.trim() ?? ""
  const status = payload.status
  if (
    !id
    || (requireHostedUrl ? !isStripeHostedUrl(redirectUrl) : Boolean(redirectUrl) && !isStripeHostedUrl(redirectUrl))
    || (status !== "open" && status !== "complete" && status !== "expired")
  ) {
    throw new Error("Stripe did not return a valid hosted Checkout Session.")
  }
  if (typeof payload.expires_at !== "number" || !Number.isFinite(payload.expires_at)) {
    throw new Error("Stripe did not return a valid Checkout Session expiry.")
  }
  return {
    id,
    url: redirectUrl,
    status,
    paymentStatus: payload.payment_status?.trim() ?? "",
    expiresAt: payload.expires_at,
    customerId: stripeExpandableId(payload.customer),
    subscriptionId: stripeExpandableId(payload.subscription),
    clientReferenceId: payload.client_reference_id?.trim() ?? "",
    metadata: payload.metadata ?? {},
  }
}

function stripeExpandableId(value: string | { id?: string } | null | undefined) {
  return typeof value === "string" ? value : value?.id?.trim() ?? ""
}
