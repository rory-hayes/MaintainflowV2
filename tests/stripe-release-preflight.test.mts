import assert from "node:assert/strict"
import test from "node:test"

import { verifyStripeReleaseObjects } from "../scripts/lib/stripe-release-preflight.mjs"

const values = {
  STRIPE_SECRET_KEY: "sk_live_release",
  STRIPE_PRICE_SOLO: "price_solo_monthly",
  STRIPE_PRICE_TEAM: "price_team_monthly",
  STRIPE_PRICE_AGENCY: "price_agency_monthly",
  STRIPE_PRICE_SOLO_ANNUAL: "price_solo_annual",
  STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual",
  STRIPE_PRICE_AGENCY_ANNUAL: "price_agency_annual",
  STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID: "bpc_release",
}

const contracts = new Map([
  ["price_solo_monthly", { plan: "solo", interval: "monthly", amount: 4_900, recurring: "month", product: "prod_solo" }],
  ["price_team_monthly", { plan: "team", interval: "monthly", amount: 14_900, recurring: "month", product: "prod_team" }],
  ["price_agency_monthly", { plan: "agency", interval: "monthly", amount: 39_900, recurring: "month", product: "prod_agency" }],
  ["price_solo_annual", { plan: "solo", interval: "annual", amount: 52_920, recurring: "year", product: "prod_solo" }],
  ["price_team_annual", { plan: "team", interval: "annual", amount: 160_920, recurring: "year", product: "prod_team" }],
  ["price_agency_annual", { plan: "agency", interval: "annual", amount: 430_920, recurring: "year", product: "prod_agency" }],
])

test("Stripe release preflight verifies exact live Prices, Products and portal coverage", async () => {
  const calls: Array<{ url: string; authorization: string }> = []
  const results = await verifyStripeReleaseObjects(values, {
    stage: "launch",
    fetchImpl: providerFetch(calls),
  })

  assert.equal(results.some((result) => result.level === "BLOCK"), false)
  assert.equal(calls.length, 10)
  assert.equal(calls.every((call) => call.authorization === "Bearer sk_live_release"), true)
  assert.equal(
    calls.some((call) => new URL(call.url).searchParams.getAll("expand[]").includes("features.subscription_update.products")),
    true,
  )
})

test("Stripe release preflight blocks legacy overlap and provider-object drift", async () => {
  const results = await verifyStripeReleaseObjects({
    ...values,
    STRIPE_LEGACY_PRICE_STARTER: "price_solo_monthly",
  }, {
    stage: "launch",
    fetchImpl: providerFetch([], { wrongTeamAmount: true, portalExtraPrice: "price_legacy" }),
  })

  assert.equal(results.some((result) => result.message.includes("disjoint") && result.level === "BLOCK"), true)
  assert.equal(results.some((result) => result.message.includes("team monthly") && result.level === "BLOCK"), true)
  assert.equal(results.some((result) => result.message.includes("Customer Portal") && result.level === "BLOCK"), true)
})

function providerFetch(
  calls: Array<{ url: string; authorization: string }>,
  options: { wrongTeamAmount?: boolean; portalExtraPrice?: string } = {},
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ url, authorization: headers.get("authorization") ?? "" })
    const path = new URL(url).pathname
    if (path.startsWith("/v1/prices/")) {
      const id = decodeURIComponent(path.split("/").pop() ?? "")
      const contract = contracts.get(id)
      if (!contract) return Response.json({ error: { message: "not found" } }, { status: 404 })
      return Response.json({
        id,
        active: true,
        livemode: true,
        currency: "eur",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: options.wrongTeamAmount && id === "price_team_monthly" ? 1 : contract.amount,
        product: contract.product,
        recurring: { interval: contract.recurring, interval_count: 1, usage_type: "licensed" },
        metadata: {
          billing_contract_version: "business_evals_v1",
          maintainflow_plan: contract.plan,
          billing_interval: contract.interval,
        },
      })
    }
    if (path.startsWith("/v1/products/")) {
      const id = decodeURIComponent(path.split("/").pop() ?? "")
      const plan = id.replace("prod_", "")
      return Response.json({
        id,
        active: true,
        livemode: true,
        name: `Maintain Flow ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`,
        metadata: { billing_contract_version: "business_evals_v1", maintainflow_plan: plan },
      })
    }
    if (path === "/v1/billing_portal/configurations/bpc_release") {
      const portalPrices = [...contracts.entries()].map(([id, contract]) => ({ id, ...contract }))
      const products = ["solo", "team", "agency"].map((plan) => ({
        product: `prod_${plan}`,
        prices: [
          ...portalPrices.filter((price) => price.plan === plan).map((price) => price.id),
          ...(plan === "solo" && options.portalExtraPrice ? [options.portalExtraPrice] : []),
        ],
      }))
      return Response.json({
        id: "bpc_release",
        active: true,
        livemode: true,
        business_profile: {
          terms_of_service_url: "https://www.maintainflow.io/terms",
          privacy_policy_url: "https://www.maintainflow.io/privacy",
        },
        features: {
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true },
          subscription_update: { enabled: true, default_allowed_updates: ["price"], products },
        },
      })
    }
    return Response.json({ error: { message: "unexpected" } }, { status: 404 })
  }) as typeof fetch
}
