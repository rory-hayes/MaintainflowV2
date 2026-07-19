import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isCardFreeWorkspaceTrialActive,
  entitledPlanForStripeStatus,
  getEffectiveBillingPlan,
  normalizeStripeSubscriptionStatus,
  resolveBillingEntitlement,
  stripeStatusGrantsPaidAccess,
} from "../src/lib/billing/entitlements.ts"
import {
  annualBillingDiscountPercent,
  billingAnnualTotalEur,
  billingCheckoutUnitAmountCents,
  billingPlanIds,
  billingPlans,
  billingPriceDisplay,
  businessEvalsBillingContractVersion,
  cardFreeWorkspaceTrialDays,
  cardFreeWorkspaceTrialPlanId,
  getBillingInterval,
  getBillingPlan,
  getLegacyBillingPlan,
  isBillingInterval,
  isBillingPlanId,
  publicBillingPlanIds,
} from "../src/lib/billing/plans.ts"
import {
  checkoutConfigReason,
  createStripeCheckoutSession,
  createStripeCustomerPortalSession,
  getBillingPlanIdForStripePrice,
  getStripeBillingStatus,
  getTrustedBillingOrigin,
  isBillingPortalFlow,
  isStripeHostedUrl,
  portalConfigReason,
  retrieveStripeSubscription,
  resolveStripeSubscriptionPlanId,
  verifyStripeWebhookSignature,
} from "../src/lib/billing/stripe.ts"

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

test("Free, Solo, Team, and Agency publish the locked Business Evals prices, limits, and features", () => {
  assert.deepEqual(billingPlanIds, ["free", "starter", "growth", "scale", "agency_plus"])
  assert.deepEqual(publicBillingPlanIds, ["free", "starter", "growth", "scale"])
  assert.equal(annualBillingDiscountPercent, 10)
  assert.equal(businessEvalsBillingContractVersion, "business_evals_v1")
  assert.equal(cardFreeWorkspaceTrialDays, 14)
  assert.equal(cardFreeWorkspaceTrialPlanId, "growth")
  assert.deepEqual(
    Object.fromEntries(
      (["free", "starter", "growth", "scale"] as const).map((planId) => {
        const plan = billingPlans[planId]
        return [planId, {
          publicKey: plan.publicKey,
          name: plan.name,
          price: plan.price,
          monthlyPriceEur: plan.monthlyPriceEur,
          businessEvalLimits: plan.businessEvalLimits,
          features: plan.features,
          limits: plan.limits,
          workflowsPerClient: plan.workflowsPerClient,
          checkoutEligible: plan.checkoutEligible,
          cardFreeTrialEligible: plan.cardFreeTrialEligible,
        }]
      })
    ),
    {
      free: {
        publicKey: "free",
        name: "Free",
        price: "€0/month",
        monthlyPriceEur: 0,
        businessEvalLimits: { projects: 1, journeys: 1, runsPerMonth: 35, evidenceRetentionDays: 7, seats: 1 },
        features: { email: false, webhook: false, liveLink: false, pdf: false, whiteLabel: false },
        // Transitional limits preserve the legacy endpoint-assurance runtime.
        // Business Evals enforcement uses businessEvalLimits and features above.
        limits: { clients: 1, workflows: 3, reportsPerMonth: 1 },
        workflowsPerClient: 3,
        checkoutEligible: false,
        cardFreeTrialEligible: false,
      },
      starter: {
        publicKey: "solo",
        name: "Solo",
        price: "€49/month",
        monthlyPriceEur: 49,
        businessEvalLimits: { projects: 3, journeys: 5, runsPerMonth: 750, evidenceRetentionDays: 30, seats: 2 },
        features: { email: true, webhook: true, liveLink: true, pdf: true, whiteLabel: false },
        limits: { clients: 3, workflows: 5, reportsPerMonth: null },
        workflowsPerClient: null,
        checkoutEligible: true,
        cardFreeTrialEligible: false,
      },
      growth: {
        publicKey: "team",
        name: "Team",
        price: "€149/month",
        monthlyPriceEur: 149,
        businessEvalLimits: { projects: 15, journeys: 30, runsPerMonth: 7_500, evidenceRetentionDays: 90, seats: 5 },
        features: { email: true, webhook: true, liveLink: true, pdf: true, whiteLabel: false },
        limits: { clients: 15, workflows: 30, reportsPerMonth: null },
        workflowsPerClient: null,
        checkoutEligible: true,
        cardFreeTrialEligible: true,
      },
      scale: {
        publicKey: "agency",
        name: "Agency",
        price: "€399/month",
        monthlyPriceEur: 399,
        businessEvalLimits: { projects: 50, journeys: 100, runsPerMonth: 30_000, evidenceRetentionDays: 365, seats: 15 },
        features: { email: true, webhook: true, liveLink: true, pdf: true, whiteLabel: true },
        limits: { clients: 50, workflows: 100, reportsPerMonth: null },
        workflowsPerClient: null,
        checkoutEligible: true,
        cardFreeTrialEligible: false,
      },
    }
  )

  assert.equal(billingPlans.agency_plus.checkoutEligible, false)
  assert.equal(billingPlans.agency_plus.monthlyPriceEur, null)
  assert.equal(billingPlans.agency_plus.contractVersion, "legacy")
  assert.equal(getLegacyBillingPlan("starter").price, "€99/month")
  assert.deepEqual(getLegacyBillingPlan("growth").limits, { clients: 10, workflows: 100, reportsPerMonth: 15 })
  assert.equal(isBillingPlanId("growth"), true)
  assert.equal(isBillingPlanId("enterprise"), false)
  assert.equal(isBillingInterval("annual"), true)
  assert.equal(isBillingInterval("quarterly"), false)
  assert.equal(getBillingPlan("unknown").id, "free")
  assert.equal(getBillingInterval("unknown"), "monthly")
  assert.equal(billingAnnualTotalEur(billingPlans.starter), 529.2)
  assert.equal(billingCheckoutUnitAmountCents(billingPlans.starter, "annual"), 52_920)
  assert.equal(billingCheckoutUnitAmountCents(billingPlans.free, "monthly"), null)
  assert.match(billingPriceDisplay(billingPlans.starter, "annual").note, /10% discount/)
  assert.match(billingPriceDisplay(billingPlans.free, "monthly").note, /One 14-day Team trial/)
})

test("checkout allowlisting accepts only Solo, Team, and Agency when new Stripe prices are configured", () => {
  const originalSecret = process.env.STRIPE_SECRET_KEY
  const originalStarterPrice = process.env.STRIPE_PRICE_SOLO
  const originalGrowthPrice = process.env.STRIPE_PRICE_TEAM
  const originalScalePrice = process.env.STRIPE_PRICE_AGENCY
  const originalStarterAnnualPrice = process.env.STRIPE_PRICE_SOLO_ANNUAL
  const originalGrowthAnnualPrice = process.env.STRIPE_PRICE_TEAM_ANNUAL
  const originalScaleAnnualPrice = process.env.STRIPE_PRICE_AGENCY_ANNUAL
  const originalPortalEnabled = process.env.STRIPE_CUSTOMER_PORTAL_ENABLED
  const originalPortalConfigurationId = process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID

  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_self_serve"
    process.env.STRIPE_PRICE_SOLO = "price_starter_monthly"
    process.env.STRIPE_PRICE_TEAM = "price_growth_monthly"
    process.env.STRIPE_PRICE_AGENCY = "price_scale_monthly"
    delete process.env.STRIPE_PRICE_SOLO_ANNUAL
    process.env.STRIPE_PRICE_TEAM_ANNUAL = "price_growth_annual"
    delete process.env.STRIPE_PRICE_AGENCY_ANNUAL
    process.env.STRIPE_CUSTOMER_PORTAL_ENABLED = "true"
    process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID = "bpc_test_self_serve"

    assert.match(checkoutConfigReason("not-a-plan"), /supported Maintain Flow plan/)
    assert.match(checkoutConfigReason("free"), /does not require Stripe checkout/)
    assert.match(checkoutConfigReason("agency_plus"), /not available to new self-serve customers/)
    for (const planId of ["starter", "growth", "scale"] as const) {
      assert.equal(checkoutConfigReason(planId), "")
    }
    assert.match(checkoutConfigReason("starter", "annual"), /Annual billing is not available/)
    assert.equal(checkoutConfigReason("growth", "annual"), "")
    assert.match(checkoutConfigReason("scale", "annual"), /Annual billing is not available/)

    assert.equal(getBillingPlanIdForStripePrice("price_starter_monthly"), "starter")
    assert.equal(getBillingPlanIdForStripePrice("price_growth_annual"), "growth")
    assert.equal(getBillingPlanIdForStripePrice("price_unknown"), null)
    assert.deepEqual(getStripeBillingStatus(), {
      secretConfigured: true,
      prices: {
        free: Boolean(process.env.STRIPE_PRICE_FREE),
        starter: true,
        growth: true,
        scale: true,
        agency_plus: Boolean(process.env.STRIPE_PRICE_AGENCY_PLUS),
      },
      annualPrices: {
        free: Boolean(process.env.STRIPE_PRICE_FREE_ANNUAL),
        starter: Boolean(process.env.STRIPE_PRICE_SOLO_ANNUAL),
        growth: true,
        scale: Boolean(process.env.STRIPE_PRICE_AGENCY_ANNUAL),
        agency_plus: Boolean(process.env.STRIPE_PRICE_AGENCY_PLUS_ANNUAL),
      },
      checkoutConfigured: true,
      portalConfigured: true,
      workspaceTrialDays: 14,
    })

    delete process.env.STRIPE_PRICE_TEAM
    delete process.env.STRIPE_PRICE_AGENCY
    assert.equal(getStripeBillingStatus().checkoutConfigured, true)
    assert.equal(checkoutConfigReason("starter"), "")
    assert.match(checkoutConfigReason("growth"), /temporarily unavailable/)
  } finally {
    restoreEnv("STRIPE_SECRET_KEY", originalSecret)
    restoreEnv("STRIPE_PRICE_SOLO", originalStarterPrice)
    restoreEnv("STRIPE_PRICE_TEAM", originalGrowthPrice)
    restoreEnv("STRIPE_PRICE_AGENCY", originalScalePrice)
    restoreEnv("STRIPE_PRICE_SOLO_ANNUAL", originalStarterAnnualPrice)
    restoreEnv("STRIPE_PRICE_TEAM_ANNUAL", originalGrowthAnnualPrice)
    restoreEnv("STRIPE_PRICE_AGENCY_ANNUAL", originalScaleAnnualPrice)
    restoreEnv("STRIPE_CUSTOMER_PORTAL_ENABLED", originalPortalEnabled)
    restoreEnv("STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID", originalPortalConfigurationId)
  }
})

test("current Stripe Price wins, migrated subscriptions fail closed, and legacy metadata remains grandfathered", () => {
  const originalStarterPrice = process.env.STRIPE_PRICE_SOLO

  try {
    process.env.STRIPE_PRICE_SOLO = "price_current_starter"

    assert.equal(resolveStripeSubscriptionPlanId({
      priceId: "price_current_starter",
      metadataPlan: "growth",
    }), "starter")
    assert.equal(resolveStripeSubscriptionPlanId({
      priceId: "price_not_configured",
      metadataPlan: "growth",
    }), "growth")
    assert.equal(resolveStripeSubscriptionPlanId({
      priceId: "price_not_configured",
      metadataPlan: "growth",
      billingContractVersion: businessEvalsBillingContractVersion,
    }), null)
    assert.equal(resolveStripeSubscriptionPlanId({
      priceId: "price_not_configured",
      metadataPlan: "growth",
      billingContractVersion: "invented",
    }), null)
    assert.equal(resolveStripeSubscriptionPlanId({
      priceId: "price_not_configured",
      metadataPlan: "invented",
    }), null)
  } finally {
    restoreEnv("STRIPE_PRICE_SOLO", originalStarterPrice)
  }
})

test("checkout route authenticates an admin and derives all sensitive checkout fields server-side", () => {
  const source = readFileSync("src/app/api/billing/checkout/route.ts", "utf8")

  assert.match(source, /bearerToken\(request\.headers\.get\("authorization"\)\)/)
  assert.match(source, /as \{ plan\?: string; interval\?: string \}/)
  assert.match(source, /plan === "free" \|\| plan === "agency_plus"/)
  assert.match(source, /Select Solo, Team, or Agency/)
  assert.match(source, /isBillingInterval\(body\.interval\)/)
  assert.match(source, /loadBillingWorkspaceForToken\(token, request\.headers\.get\("x-maintainflow-workspace-id"\)\)/)
  assert.match(source, /assertBillingAdmin\(workspace\)/)
  assert.match(source, /origin: getTrustedBillingOrigin\(request\.nextUrl\.origin\)/)
  assert.match(source, /agencyId: workspace\.agency\.id/)
  assert.match(source, /userId: workspace\.user\.id/)
  assert.match(source, /customerId: workspace\.agency\.stripeCustomerId/)
  assert.match(source, /customerEmail: workspace\.user\.email/)
  assert.doesNotMatch(source, /body\.(?:price|amount|agencyId|userId|customerId|customerEmail)/)
  assert.match(source, /BillingAuthenticationError[\s\S]+\? 401/)
  assert.match(source, /BillingAuthorizationError[\s\S]+\? 403/)
  assert.match(source, /BillingWorkspaceRequiredError[\s\S]+\? 409/)
})

test("billing return URLs use a trusted configured origin with a production-safe fallback", () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL
  const originalVercelEnv = process.env.VERCEL_ENV

  try {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.VERCEL_ENV
    assert.equal(getTrustedBillingOrigin("http://localhost:3000"), "http://localhost:3000")

    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test/path"
    assert.equal(getTrustedBillingOrigin("https://attacker.example"), "https://app.example.test")

    process.env.NEXT_PUBLIC_SITE_URL = "https://www.example.test/a/path"
    assert.equal(getTrustedBillingOrigin("https://attacker.example"), "https://www.example.test")

    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.NEXT_PUBLIC_APP_URL
    process.env.VERCEL_ENV = "production"
    assert.equal(getTrustedBillingOrigin("https://attacker.example"), "https://www.maintainflow.io")

    process.env.NEXT_PUBLIC_SITE_URL = "not a valid URL"
    assert.throws(() => getTrustedBillingOrigin("https://attacker.example"), /return URL is not configured correctly/)
  } finally {
    restoreEnv("NEXT_PUBLIC_SITE_URL", originalSiteUrl)
    restoreEnv("NEXT_PUBLIC_APP_URL", originalAppUrl)
    restoreEnv("VERCEL_ENV", originalVercelEnv)
  }
})

test("checkout creation sends trusted Business Evals metadata without restarting a trial", async () => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const originalSecret = process.env.STRIPE_SECRET_KEY
  const originalStarterPrice = process.env.STRIPE_PRICE_SOLO
  let capturedInput: string | URL | Request = ""
  let capturedInit: RequestInit | undefined

  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_checkout"
    process.env.STRIPE_PRICE_SOLO = "price_starter_monthly"
    Date.now = () => 1_800_000_000_000
    globalThis.fetch = (async (input, init) => {
      capturedInput = input
      capturedInit = init
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const result = await createStripeCheckoutSession({
      planId: "starter",
      interval: "monthly",
      origin: "https://www.maintainflow.io",
      agencyId: "agency_123",
      userId: "user_123",
      customerId: " cus_123 ",
      customerEmail: "ignored@example.com",
      idempotencyKey: "checkout-request-123",
    })

    assert.equal(result, "https://checkout.stripe.com/c/pay/cs_test_123")
    assert.equal(String(capturedInput), "https://api.stripe.com/v1/checkout/sessions")
    assert.equal(capturedInit?.method, "POST")
    const headers = new Headers(capturedInit?.headers)
    assert.equal(headers.get("authorization"), "Bearer sk_test_checkout")
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded")
    const checkoutIdempotencyKey = headers.get("idempotency-key")
    assert.ok(checkoutIdempotencyKey)
    assert.match(checkoutIdempotencyKey, /^maintainflow-checkout-[a-f0-9]{64}$/)

    const body = new URLSearchParams(String(capturedInit?.body))
    assert.equal(body.get("mode"), "subscription")
    assert.equal(body.get("success_url"), "https://www.maintainflow.io/settings?tab=billing&billing=checkout-success")
    assert.equal(body.get("cancel_url"), "https://www.maintainflow.io/settings?tab=billing&billing=checkout-cancelled")
    assert.equal(body.get("line_items[0][price]"), "price_starter_monthly")
    assert.equal(body.get("line_items[0][quantity]"), "1")
    assert.equal(body.get("allow_promotion_codes"), "true")
    assert.equal(body.get("client_reference_id"), "agency_123")
    assert.equal(body.get("metadata[maintainflow_plan]"), "starter")
    assert.equal(body.get("metadata[maintainflow_billing_interval]"), "monthly")
    assert.equal(body.get("metadata[maintainflow_billing_contract]"), "business_evals_v1")
    assert.equal(body.get("metadata[maintainflow_agency_id]"), "agency_123")
    assert.equal(body.get("metadata[maintainflow_user_id]"), "user_123")
    assert.equal(body.has("subscription_data[trial_period_days]"), false)
    assert.equal(body.get("subscription_data[metadata][maintainflow_plan]"), "starter")
    assert.equal(body.get("subscription_data[metadata][maintainflow_billing_contract]"), "business_evals_v1")
    assert.equal(body.get("subscription_data[metadata][maintainflow_agency_id]"), "agency_123")
    assert.equal(body.get("customer"), "cus_123")
    assert.equal(body.has("customer_email"), false)
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
    restoreEnv("STRIPE_SECRET_KEY", originalSecret)
    restoreEnv("STRIPE_PRICE_SOLO", originalStarterPrice)
  }
})

test("Stripe redirects are restricted to HTTPS Stripe hosts and invalid checkout responses fail closed", async () => {
  assert.equal(isStripeHostedUrl("https://checkout.stripe.com/c/pay/session"), true)
  assert.equal(isStripeHostedUrl("https://billing.stripe.com/p/session/test"), true)
  assert.equal(isStripeHostedUrl("http://checkout.stripe.com/c/pay/session"), false)
  assert.equal(isStripeHostedUrl("https://checkout.stripe.evil.test/c/pay/session"), false)
  assert.equal(isStripeHostedUrl("https://maintainflow.io/settings"), false)

  const originalFetch = globalThis.fetch
  const originalSecret = process.env.STRIPE_SECRET_KEY
  const originalGrowthPrice = process.env.STRIPE_PRICE_TEAM
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_checkout"
    process.env.STRIPE_PRICE_TEAM = "price_growth_monthly"
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ url: "https://checkout.stripe.evil.test/c/pay/session" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch

    await assert.rejects(
      createStripeCheckoutSession({
        planId: "growth",
        origin: "https://www.maintainflow.io",
        agencyId: "agency_123",
        userId: "user_123",
        idempotencyKey: "checkout-request-456",
      }),
      /valid hosted checkout URL/
    )
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("STRIPE_SECRET_KEY", originalSecret)
    restoreEnv("STRIPE_PRICE_TEAM", originalGrowthPrice)
  }
})

test("Stripe webhook signatures accept current valid payloads and reject tampering or replay", () => {
  const payload = JSON.stringify({ id: "evt_123", type: "checkout.session.completed" })
  const timestamp = 1_800_000_000
  const secret = "whsec_test"
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")
  const header = `t=${timestamp},v1=${signature}`

  assert.doesNotThrow(() =>
    verifyStripeWebhookSignature({ payload, signatureHeader: header, secret, nowMs: timestamp * 1000 })
  )
  assert.doesNotThrow(() =>
    verifyStripeWebhookSignature({
      payload,
      signatureHeader: `t=${timestamp},v1=${"0".repeat(64)},v1=${signature}`,
      secret,
      nowMs: timestamp * 1000,
    })
  )
  assert.throws(
    () => verifyStripeWebhookSignature({ payload: `${payload}x`, signatureHeader: header, secret, nowMs: timestamp * 1000 }),
    /verification failed/
  )
  assert.throws(
    () => verifyStripeWebhookSignature({ payload, signatureHeader: header, secret, nowMs: (timestamp + 301) * 1000 }),
    /outside the allowed tolerance/
  )
})

test("subscription reconciliation retrieves current Stripe state server-side and surfaces Stripe failures", async () => {
  const originalFetch = globalThis.fetch
  const originalSecret = process.env.STRIPE_SECRET_KEY
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []

  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_reconcile"
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        id: "sub/current value",
        customer: "cus_123",
        status: "active",
        metadata: { maintainflow_plan: "growth" },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const snapshot = await retrieveStripeSubscription(" sub/current value ")
    assert.equal(snapshot.id, "sub/current value")
    assert.equal(String(calls[0]?.input), "https://api.stripe.com/v1/subscriptions/sub%2Fcurrent%20value")
    assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer sk_test_reconcile")
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal)

    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: "subscription unavailable" } }),
      { status: 503, headers: { "content-type": "application/json" } }
    )) as typeof fetch
    await assert.rejects(retrieveStripeSubscription("sub_123"), /subscription unavailable/)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("STRIPE_SECRET_KEY", originalSecret)
  }
})

test("webhooks reconcile mutable events from current Stripe subscription state", () => {
  const delegateSource = readFileSync("src/app/api/stripe/webhook/route.ts", "utf8")
  const source = readFileSync("src/app/api/billing/webhook/route.ts", "utf8")

  assert.match(delegateSource, /billing\/webhook\/route/)
  assert.match(delegateSource, /POST/)
  assert.match(source, /verifyStripeWebhookSignature/)
  assert.match(source, /checkout\.session\.completed[\s\S]+handleCheckoutCompleted/)
  assert.match(source, /customer\.subscription\.created" \|\| event\.type === "customer\.subscription\.updated"\)[\s\S]+currentSubscription/)
  assert.match(source, /invoice\.payment_failed" \|\| event\.type === "invoice\.paid"\)[\s\S]+currentSubscription\(\{ id: subscriptionId \}\)/)
  assert.match(source, /handleCheckoutCompleted[\s\S]+currentSubscription\(\{ id: subscriptionId \}\)/)
  assert.match(source, /return retrieveStripeSubscription\(subscriptionId\)/)
  assert.match(source, /loadAgencyBillingContractVersionByStripeReference\([\s\S]+effectiveBillingContract[\s\S]+resolveStripeSubscriptionPlanId/)
  assert.match(source, /resolveStripeSubscriptionPlanId\(\{[\s\S]+priceId:[\s\S]+metadataPlan/)
  assert.match(source, /entitledPlanForStripeStatus\(plan, stripeSubscriptionStatus\)/)
  assert.match(source, /const entitledPlan = plan[\s\S]+: "free"/)
  assert.doesNotMatch(source, /stripeStatusGrantsPaidAccess\(stripeSubscriptionStatus\)[\s\S]+undefined/)
  assert.match(source, /plan: "free"[\s\S]+stripeSubscriptionStatus: "canceled"[\s\S]+clearSubscription: true/)
})

test("billing returns stay on Settings and poll the workspace for webhook-updated entitlement", () => {
  const settingsSource = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")
  const coreLoopSource = readFileSync("src/hooks/use-core-loop.ts", "utf8")

  assert.match(coreLoopSource, /const reloadWorkspace = useCallback\(async \(\) =>/)
  assert.match(coreLoopSource, /reloadWorkspace,[\s\S]+createAgency/)
  assert.match(settingsSource, /billingReturn !== "checkout-success" && billingReturn !== "portal-return"/)
  assert.match(settingsSource, /await reloadWorkspace\(\)/)
  assert.match(settingsSource, /\[1_500, 3_000, 5_000\]/)
  assert.match(settingsSource, /Finished checking for Stripe's latest billing status/)
  assert.doesNotMatch(settingsSource, /Billing status has been refreshed/)
})

test("one card-free workspace trial grants Team until its fixed end, then falls back to Free", () => {
  const nowMs = Date.parse("2026-07-18T12:00:00.000Z")
  const trialWorkspace = {
    plan: "free" as const,
    trialEndsAt: "2026-08-01T12:00:00.000Z",
    stripeCustomerId: "",
    stripeSubscriptionId: "",
    stripeSubscriptionStatus: "" as const,
    complimentaryEntitlement: false,
    complimentaryEntitlementReason: "",
  }

  assert.equal(isCardFreeWorkspaceTrialActive(trialWorkspace.trialEndsAt, nowMs), true)
  assert.equal(isCardFreeWorkspaceTrialActive("not-a-date", nowMs), false)

  const activeTrial = resolveBillingEntitlement(trialWorkspace, nowMs)
  assert.equal(activeTrial.state, "workspace_trial")
  assert.equal(activeTrial.effectivePlanId, "growth")
  assert.equal(activeTrial.contractVersion, "business_evals_v1")
  assert.equal(activeTrial.grandfathered, false)
  assert.equal(activeTrial.grantsPaidAccess, true)

  const expiredTrial = resolveBillingEntitlement(trialWorkspace, Date.parse("2026-08-01T12:00:00.000Z"))
  assert.equal(expiredTrial.state, "free")
  assert.equal(expiredTrial.effectivePlanId, "free")
  assert.equal(expiredTrial.grantsPaidAccess, false)

  assert.equal(resolveBillingEntitlement({
    ...trialWorkspace,
    stripeCustomerId: "cus_cancelled",
    stripeSubscriptionId: "sub_cancelled",
    stripeSubscriptionStatus: "canceled" as const,
  }, nowMs).state, "cancelled")
})

test("Stripe status entitlements fail closed unless a paid plan is currently backed", () => {
  const linkedGrowth = {
    plan: "growth" as const,
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    stripeSubscriptionStatus: "active" as const,
    complimentaryEntitlement: false,
    complimentaryEntitlementReason: "",
  }

  for (const plan of ["starter", "growth", "scale"] as const) {
    for (const status of ["trialing", "active"] as const) {
      assert.equal(entitledPlanForStripeStatus(plan, status), plan)
      assert.equal(stripeStatusGrantsPaidAccess(status), true)
      const entitlement = resolveBillingEntitlement({ ...linkedGrowth, plan, stripeSubscriptionStatus: status })
      assert.equal(entitlement.effectivePlanId, plan)
      assert.equal(entitlement.contractVersion, "legacy")
      assert.equal(entitlement.grandfathered, true)
      assert.equal(entitlement.grantsPaidAccess, true)
    }
  }

  for (const status of ["incomplete", "incomplete_expired", "past_due", "canceled", "unpaid", "paused"] as const) {
    assert.equal(entitledPlanForStripeStatus("growth", status), "free")
    assert.equal(stripeStatusGrantsPaidAccess(status), false)
    assert.equal(resolveBillingEntitlement({ ...linkedGrowth, stripeSubscriptionStatus: status }).effectivePlanId, "free")
  }

  assert.equal(normalizeStripeSubscriptionStatus("invented"), "")
  assert.equal(entitledPlanForStripeStatus("agency_plus", "active"), "free")
  assert.equal(resolveBillingEntitlement({ ...linkedGrowth, stripeCustomerId: "" }).state, "invalid")
  assert.equal(resolveBillingEntitlement({ ...linkedGrowth, stripeSubscriptionId: "" }).state, "invalid")
  assert.equal(resolveBillingEntitlement({ ...linkedGrowth, stripeSubscriptionStatus: "" }).state, "invalid")
  assert.equal(getEffectiveBillingPlan({ ...linkedGrowth, stripeSubscriptionStatus: "past_due" }).id, "free")
  assert.equal(getEffectiveBillingPlan(linkedGrowth).name, "Growth (legacy)")
  assert.deepEqual(getEffectiveBillingPlan(linkedGrowth).limits, { clients: 10, workflows: 100, reportsPerMonth: 15 })

  const migrated = resolveBillingEntitlement({
    ...linkedGrowth,
    billingContractVersion: businessEvalsBillingContractVersion,
  })
  assert.equal(migrated.state, "active_subscription")
  assert.equal(migrated.contractVersion, "business_evals_v1")
  assert.equal(migrated.grandfathered, false)
  assert.equal(getEffectiveBillingPlan({
    ...linkedGrowth,
    billingContractVersion: businessEvalsBillingContractVersion,
  }).name, "Team")

  const complimentary = resolveBillingEntitlement({
    ...linkedGrowth,
    stripeCustomerId: "",
    stripeSubscriptionId: "",
    stripeSubscriptionStatus: "",
    complimentaryEntitlement: true,
    complimentaryEntitlementReason: "Legacy migration credit",
  })
  assert.equal(complimentary.state, "complimentary")
  assert.equal(complimentary.effectivePlanId, "growth")
  assert.equal(complimentary.grantsPaidAccess, true)
  assert.equal(resolveBillingEntitlement({
    ...linkedGrowth,
    stripeCustomerId: "",
    stripeSubscriptionId: "",
    stripeSubscriptionStatus: "",
    complimentaryEntitlement: true,
    complimentaryEntitlementReason: " ",
  }).effectivePlanId, "free")
})

test("customer portal access requires a server-side Stripe customer link", () => {
  const originalSecret = process.env.STRIPE_SECRET_KEY
  const originalPortalEnabled = process.env.STRIPE_CUSTOMER_PORTAL_ENABLED
  const originalPortalConfigurationId = process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID

  try {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_CUSTOMER_PORTAL_ENABLED
    delete process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID
    assert.match(portalConfigReason("cus_123"), /STRIPE_SECRET_KEY/)
    process.env.STRIPE_SECRET_KEY = "sk_test_123"
    assert.match(portalConfigReason("cus_123"), /not enabled/)
    process.env.STRIPE_CUSTOMER_PORTAL_ENABLED = "true"
    assert.equal(getStripeBillingStatus().portalConfigured, false)
    assert.equal(
      portalConfigReason("cus_123"),
      "Stripe Customer Portal needs STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID before it can open."
    )
    process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID = "bpc_test_123"
    assert.match(portalConfigReason(null), /synced Stripe customer/)
    assert.equal(portalConfigReason("cus_123"), "")
    assert.match(portalConfigReason("cus_123", "subscription_update"), /synced subscription/)
    assert.equal(portalConfigReason("cus_123", "subscription_update", "sub_123"), "")
    assert.equal(isBillingPortalFlow("manage"), true)
    assert.equal(isBillingPortalFlow("subscription_update"), true)
    assert.equal(isBillingPortalFlow("cancel_immediately"), false)
  } finally {
    restoreEnv("STRIPE_SECRET_KEY", originalSecret)
    restoreEnv("STRIPE_CUSTOMER_PORTAL_ENABLED", originalPortalEnabled)
    restoreEnv("STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID", originalPortalConfigurationId)
  }
})

test("customer portal supports standard management and a server-derived subscription update deep link", async () => {
  const originalFetch = globalThis.fetch
  const originalSecret = process.env.STRIPE_SECRET_KEY
  const originalPortalEnabled = process.env.STRIPE_CUSTOMER_PORTAL_ENABLED
  const originalPortalConfigurationId = process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID
  const calls: RequestInit[] = []

  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_portal"
    process.env.STRIPE_CUSTOMER_PORTAL_ENABLED = "true"
    process.env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID = "bpc_test_portal"
    globalThis.fetch = (async (_input, init) => {
      calls.push(init ?? {})
      return new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    await createStripeCustomerPortalSession({
      customerId: "cus_123",
      origin: "https://www.maintainflow.io",
    })
    await createStripeCustomerPortalSession({
      customerId: "cus_123",
      subscriptionId: "sub_123",
      origin: "https://www.maintainflow.io",
      flow: "subscription_update",
    })

    const manageBody = new URLSearchParams(String(calls[0]?.body))
    const updateBody = new URLSearchParams(String(calls[1]?.body))
    const returnUrl = "https://www.maintainflow.io/settings?tab=billing&billing=portal-return"

    assert.equal(manageBody.get("customer"), "cus_123")
    assert.equal(manageBody.get("configuration"), "bpc_test_portal")
    assert.equal(manageBody.get("return_url"), returnUrl)
    assert.equal(manageBody.has("flow_data[type]"), false)
    assert.equal(updateBody.get("customer"), "cus_123")
    assert.equal(updateBody.get("configuration"), "bpc_test_portal")
    assert.equal(updateBody.get("return_url"), returnUrl)
    assert.equal(updateBody.get("flow_data[type]"), "subscription_update")
    assert.equal(updateBody.get("flow_data[subscription_update][subscription]"), "sub_123")
    assert.equal(updateBody.get("flow_data[after_completion][type]"), "redirect")
    assert.equal(updateBody.get("flow_data[after_completion][redirect][return_url]"), returnUrl)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv("STRIPE_SECRET_KEY", originalSecret)
    restoreEnv("STRIPE_CUSTOMER_PORTAL_ENABLED", originalPortalEnabled)
    restoreEnv("STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID", originalPortalConfigurationId)
  }
})

test("portal route allowlists the flow and derives customer and subscription from the authenticated workspace", () => {
  const source = readFileSync("src/app/api/billing/portal/route.ts", "utf8")

  assert.match(source, /loadBillingWorkspaceForToken\(token, request\.headers\.get\("x-maintainflow-workspace-id"\)\)/)
  assert.match(source, /assertBillingAdmin\(workspace\)/)
  assert.match(source, /isBillingPortalFlow\(flow\)/)
  assert.match(source, /customerId: workspace\.agency\.stripeCustomerId/)
  assert.match(source, /subscriptionId: workspace\.agency\.stripeSubscriptionId/)
  assert.doesNotMatch(source, /body\.(?:customerId|subscriptionId)/)
})

test("interactive billing routes require an explicit selected workspace", () => {
  const workspace = readFileSync("src/lib/billing/workspace.server.ts", "utf8")
  const status = readFileSync("src/app/api/billing/status/route.ts", "utf8")
  const trial = readFileSync("src/app/api/billing/team-trial/route.ts", "utf8")
  const legacySettings = readFileSync("src/components/app/maintainflow-screen.tsx", "utf8")

  assert.match(workspace, /if \(!agencyId\) \{[\s\S]+Select a billing workspace before continuing/)
  assert.match(workspace, /agency_id: `eq\.\$\{agencyId\}`/)
  assert.doesNotMatch(workspace, /\.\.\.\(agencyId \? \{ agency_id:/)
  assert.match(status, /loadBillingWorkspaceForToken\(token, request\.headers\.get\("x-maintainflow-workspace-id"\)\)/)
  assert.match(status, /BillingWorkspaceRequiredError[\s\S]+\? 409/)
  assert.match(trial, /loadBillingWorkspaceForToken\(token, request\.headers\.get\("x-maintainflow-workspace-id"\)\)/)
  assert.match(legacySettings, /"X-MaintainFlow-Workspace-Id": workspaceId/)
  assert.match(legacySettings, /"X-MaintainFlow-Workspace-Id": core\.agency\.id/)
})

test("Stripe webhooks claim and finalize a payload-bound provider receipt", () => {
  const route = readFileSync("src/app/api/billing/webhook/route.ts", "utf8")
  const receipts = readFileSync("src/lib/billing/stripe-webhook-receipts.server.ts", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")

  assert.match(route, /claimStripeWebhookReceipt/)
  assert.match(route, /finishStripeWebhookReceipt\(receipt, true\)/)
  assert.match(route, /finishStripeWebhookReceipt\(receipt, false\)/)
  assert.match(route, /receipt\.status === "processed"/)
  assert.match(receipts, /createHash\("sha256"\)\.update\(input\.rawPayload\)/)
  assert.match(receipts, /rpc\/claim_provider_webhook_receipt/)
  assert.match(receipts, /rpc\/finish_provider_webhook_receipt/)
  assert.match(migration, /PROVIDER_WEBHOOK_EVENT_MISMATCH/)
  assert.match(migration, /receipt\.claim_token = p_claim_token/)
  assert.match(migration, /p_stale_after_seconds not between 30 and 3600/)
})
