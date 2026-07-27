import "server-only"

import { createHash } from "node:crypto"

import type { BillingInterval, BillingPlanId } from "@/lib/billing/plans"
import { supabaseServiceJson } from "@/lib/supabase/server"

// Stripe requires expires_at to be at least 30 minutes after Session creation.
// Reserving 35 minutes leaves room for DB and network latency before the API call.
export const stripeCheckoutProviderLifetimeSeconds = 35 * 60

export type StripeCheckoutPlanId = Extract<BillingPlanId, "starter" | "growth" | "scale">
export type StripeCheckoutReservationStatus = "creating" | "open" | "complete" | "expired" | "failed"

type ReservationRow = {
  id: string
  agency_id: string
  requested_by_user_id: string
  plan_id: StripeCheckoutPlanId
  billing_interval: BillingInterval
  billing_origin: string
  customer_id: string
  customer_email: string
  idempotency_key_hash: string
  provider_idempotency_key: string
  stripe_session_id: string | null
  checkout_url: string | null
  status: StripeCheckoutReservationStatus
  provider_expires_at: string
  expires_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type StripeCheckoutReservation = {
  id: string
  agencyId: string
  requestedByUserId: string
  planId: StripeCheckoutPlanId
  interval: BillingInterval
  origin: string
  customerId: string
  customerEmail: string
  providerIdempotencyKey: string
  stripeSessionId: string
  checkoutUrl: string
  status: StripeCheckoutReservationStatus
  providerExpiresAt: string
  expiresAt: string
  completedAt: string
}

export async function reserveStripeCheckoutSession(input: {
  agencyId: string
  userId: string
  planId: StripeCheckoutPlanId
  interval: BillingInterval
  origin: string
  customerId?: string
  customerEmail?: string
  idempotencyKey: string
}) {
  const idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey).digest("hex")
  const rows = await supabaseServiceJson<ReservationRow[]>("rpc/reserve_stripe_checkout_session", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_user_id: input.userId,
      p_plan_id: input.planId,
      p_billing_interval: input.interval,
      p_billing_origin: input.origin,
      p_customer_id: input.customerId?.trim() ?? "",
      p_customer_email: input.customerEmail?.trim().toLowerCase() ?? "",
      p_idempotency_key_hash: idempotencyKeyHash,
      p_lifetime_seconds: stripeCheckoutProviderLifetimeSeconds,
    }),
  })
  return requiredReservation(rows[0], "Stripe checkout reservation was not returned.")
}

export async function recordStripeCheckoutSession(input: {
  reservation: StripeCheckoutReservation
  stripeSessionId: string
  checkoutUrl: string
  providerExpiresAt: string
}) {
  const rows = await supabaseServiceJson<ReservationRow[]>("rpc/record_stripe_checkout_session", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.reservation.agencyId,
      p_reservation_id: input.reservation.id,
      p_stripe_session_id: input.stripeSessionId,
      p_checkout_url: input.checkoutUrl,
      p_provider_expires_at: input.providerExpiresAt,
    }),
  })
  return requiredReservation(rows[0], "Stripe checkout session could not be recorded.")
}

export async function loadStripeCheckoutSessionForReturn(input: {
  agencyId: string
  userId: string
  stripeSessionId: string
}) {
  const rows = await supabaseServiceJson<ReservationRow[]>("rpc/get_stripe_checkout_session_for_return", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_user_id: input.userId,
      p_stripe_session_id: input.stripeSessionId,
    }),
  })
  return rows[0] ? presentReservation(rows[0]) : null
}

export async function finishStripeCheckoutSession(input: {
  agencyId: string
  stripeSessionId: string
  status: Extract<StripeCheckoutReservationStatus, "complete" | "expired" | "failed">
}) {
  const rows = await supabaseServiceJson<ReservationRow[]>("rpc/finish_stripe_checkout_session", {
    method: "POST",
    body: JSON.stringify({
      p_agency_id: input.agencyId,
      p_stripe_session_id: input.stripeSessionId,
      p_status: input.status,
    }),
  })
  return rows[0] ? presentReservation(rows[0]) : null
}

function requiredReservation(row: ReservationRow | undefined, message: string) {
  if (!row) throw new Error(message)
  return presentReservation(row)
}

function presentReservation(row: ReservationRow): StripeCheckoutReservation {
  if (!row.id || !row.agency_id || !row.provider_idempotency_key || !row.provider_expires_at) {
    throw new Error("Stripe checkout reservation data is incomplete.")
  }
  return {
    id: row.id,
    agencyId: row.agency_id,
    requestedByUserId: row.requested_by_user_id,
    planId: row.plan_id,
    interval: row.billing_interval,
    origin: row.billing_origin,
    customerId: row.customer_id,
    customerEmail: row.customer_email,
    providerIdempotencyKey: row.provider_idempotency_key,
    stripeSessionId: row.stripe_session_id ?? "",
    checkoutUrl: row.checkout_url ?? "",
    status: row.status,
    providerExpiresAt: row.provider_expires_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at ?? "",
  }
}
