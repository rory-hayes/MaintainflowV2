import { NextRequest, NextResponse } from "next/server"

import {
  getStripeWebhookSecret,
  retrieveStripeSubscription,
  resolveStripeSubscriptionPlanId,
  verifyStripeWebhookSignature,
} from "@/lib/billing/stripe"
import { businessEvalsBillingContractVersion, isBillingPlanId } from "@/lib/billing/plans"
import {
  claimStripeWebhookReceipt,
  finishStripeWebhookReceipt,
  type StripeWebhookReceiptClaim,
} from "@/lib/billing/stripe-webhook-receipts.server"
import {
  entitledPlanForStripeStatus,
  normalizeStripeSubscriptionStatus,
} from "@/lib/billing/entitlements"
import {
  loadAgencyBillingContractVersionByStripeReference,
  updateAgencyBilling,
  updateAgencyBillingByStripeReference,
} from "@/lib/billing/workspace.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type StripeEvent = {
  id: string
  type: string
  data?: {
    object?: StripeObject
  }
}

type StripeObject = {
  id?: string
  customer?: string
  subscription?: string
  client_reference_id?: string
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

export async function POST(request: NextRequest) {
  const payload = await request.text()
  const webhookSecret = getStripeWebhookSecret()

  if (!webhookSecret) {
    console.error("Stripe webhook is unavailable because its signing secret is not configured.")
    return new NextResponse("Stripe webhook is not configured.", { status: 503 })
  }

  try {
    verifyStripeWebhookSignature({
      payload,
      signatureHeader: request.headers.get("stripe-signature"),
      secret: webhookSecret,
    })
  } catch (error) {
    console.warn("Stripe webhook signature validation failed.", {
      reason: error instanceof Error ? error.message : "unknown",
    })
    return new NextResponse("Invalid Stripe webhook signature.", { status: 400 })
  }

  let event: StripeEvent
  try {
    event = JSON.parse(payload) as StripeEvent
    if (!event.id || !event.type) throw new Error("Stripe event identity is missing.")
  } catch {
    return NextResponse.json({ error: "Invalid Stripe event payload." }, { status: 400 })
  }

  let receipt: StripeWebhookReceiptClaim
  try {
    receipt = await claimStripeWebhookReceipt({
      eventId: event.id,
      eventType: event.type,
      rawPayload: payload,
    })
  } catch (error) {
    console.error("Stripe webhook receipt claim failed.", {
      eventId: event.id,
      eventType: event.type,
      reason: error instanceof Error ? error.message : "unknown",
    })
    return NextResponse.json(
      { error: "Stripe webhook receipt could not be claimed.", reference: event.id },
      { status: 500, headers: { "Retry-After": "5" } }
    )
  }
  if (!receipt.claimed) {
    if (receipt.status === "processed") {
      return NextResponse.json({ received: true, duplicate: true })
    }
    return NextResponse.json(
      { error: "Stripe webhook is already being processed.", reference: event.id },
      { status: 503, headers: { "Retry-After": "5" } }
    )
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data?.object ?? {})
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      await handleSubscriptionUpdated(await currentSubscription(event.data?.object ?? {}))
    }

    if (event.type === "customer.subscription.deleted") {
      await handleSubscriptionDeleted(event.data?.object ?? {})
    }

    if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") {
      const invoice = event.data?.object ?? {}
      const subscriptionId = valueOrEmpty(invoice.subscription)
      if (subscriptionId) {
        await handleSubscriptionUpdated(await currentSubscription({ id: subscriptionId }))
      }
    }

    await finishStripeWebhookReceipt(receipt, true)
    return NextResponse.json({ received: true, duplicate: false })
  } catch (error) {
    await finishStripeWebhookReceipt(receipt, false).catch(() => undefined)
    console.error("Stripe webhook processing failed.", {
      eventId: event.id,
      eventType: event.type,
      reason: error instanceof Error ? error.message : "unknown",
    })
    return NextResponse.json(
      { error: "Stripe webhook could not be processed.", reference: event.id },
      { status: 500 }
    )
  }
}

async function handleCheckoutCompleted(session: StripeObject) {
  const agencyId = session.metadata?.maintainflow_agency_id || session.client_reference_id
  const plan = session.metadata?.maintainflow_plan
  const customerId = valueOrEmpty(session.customer)
  const subscriptionId = valueOrEmpty(session.subscription)

  if (!agencyId || !plan || !isBillingPlanId(plan) || plan === "free" || plan === "agency_plus") {
    return
  }

  await updateAgencyBilling(agencyId, {
    stripeCustomerId: customerId || undefined,
    stripeSubscriptionId: subscriptionId || undefined,
    ...(session.metadata?.maintainflow_billing_contract === businessEvalsBillingContractVersion
      ? { billingContractVersion: businessEvalsBillingContractVersion }
      : {}),
  })

  if (subscriptionId) {
    await handleSubscriptionUpdated(await currentSubscription({ id: subscriptionId }))
  }
}

async function handleSubscriptionUpdated(subscription: StripeObject) {
  const subscriptionId = valueOrEmpty(subscription.id)
  const customerId = valueOrEmpty(subscription.customer)
  const agencyId = valueOrEmpty(subscription.metadata?.maintainflow_agency_id)
  const metadataPlan = subscription.metadata?.maintainflow_plan
  const subscriptionBillingContract = subscription.metadata?.maintainflow_billing_contract
  const storedBillingContract = await loadAgencyBillingContractVersionByStripeReference({
    agencyId,
    customerId,
    subscriptionId,
  })
  const effectiveBillingContract = storedBillingContract === businessEvalsBillingContractVersion
    || subscriptionBillingContract === businessEvalsBillingContractVersion
    ? businessEvalsBillingContractVersion
    : storedBillingContract ?? subscriptionBillingContract
  const plan = resolveStripeSubscriptionPlanId({
    priceId: subscription.items?.data?.[0]?.price?.id,
    metadataPlan,
    billingContractVersion: effectiveBillingContract,
  })
  const stripeSubscriptionStatus = normalizeStripeSubscriptionStatus(subscription.status)
  const entitledPlan = plan
    ? entitledPlanForStripeStatus(plan, stripeSubscriptionStatus)
    : "free"
  const trialEndsAt = stripeTimestampToIso(subscription.trial_end)
  const billingContractVersion = subscriptionBillingContract === businessEvalsBillingContractVersion
    ? businessEvalsBillingContractVersion
    : undefined

  if (agencyId) {
    await updateAgencyBilling(agencyId, {
      plan: entitledPlan,
      stripeCustomerId: customerId || undefined,
      stripeSubscriptionId: subscriptionId || undefined,
      stripeSubscriptionStatus: stripeSubscriptionStatus || null,
      trialEndsAt,
      billingContractVersion,
    })
    return
  }

  await updateAgencyBillingByStripeReference({
    subscriptionId,
    customerId,
    plan: entitledPlan,
    trialEndsAt,
    stripeSubscriptionStatus: stripeSubscriptionStatus || null,
    billingContractVersion,
  })
}

async function handleSubscriptionDeleted(subscription: StripeObject) {
  await updateAgencyBillingByStripeReference({
    subscriptionId: valueOrEmpty(subscription.id),
    customerId: valueOrEmpty(subscription.customer),
    plan: "free",
    trialEndsAt: null,
    stripeSubscriptionStatus: "canceled",
    clearSubscription: true,
  })
}

function valueOrEmpty(value: unknown) {
  return typeof value === "string" ? value : ""
}

async function currentSubscription(subscription: StripeObject): Promise<StripeObject> {
  const subscriptionId = valueOrEmpty(subscription.id)
  if (!subscriptionId) {
    throw new Error("Stripe subscription identity is missing.")
  }
  return retrieveStripeSubscription(subscriptionId)
}

function stripeTimestampToIso(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
}
