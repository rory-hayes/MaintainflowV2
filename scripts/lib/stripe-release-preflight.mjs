const currentContractVersion = "business_evals_v1"
const stripeApiVersion = "2026-02-25.clover"

const priceContract = [
  { env: "STRIPE_PRICE_SOLO", plan: "solo", interval: "monthly", amount: 4_900, stripeInterval: "month" },
  { env: "STRIPE_PRICE_TEAM", plan: "team", interval: "monthly", amount: 14_900, stripeInterval: "month" },
  { env: "STRIPE_PRICE_AGENCY", plan: "agency", interval: "monthly", amount: 39_900, stripeInterval: "month" },
  { env: "STRIPE_PRICE_SOLO_ANNUAL", plan: "solo", interval: "annual", amount: 52_920, stripeInterval: "year" },
  { env: "STRIPE_PRICE_TEAM_ANNUAL", plan: "team", interval: "annual", amount: 160_920, stripeInterval: "year" },
  { env: "STRIPE_PRICE_AGENCY_ANNUAL", plan: "agency", interval: "annual", amount: 430_920, stripeInterval: "year" },
]

const legacyPriceKeys = [
  "STRIPE_LEGACY_PRICE_STARTER",
  "STRIPE_LEGACY_PRICE_GROWTH",
  "STRIPE_LEGACY_PRICE_SCALE",
  "STRIPE_LEGACY_PRICE_STARTER_ANNUAL",
  "STRIPE_LEGACY_PRICE_GROWTH_ANNUAL",
  "STRIPE_LEGACY_PRICE_SCALE_ANNUAL",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_GROWTH",
  "STRIPE_PRICE_SCALE",
  "STRIPE_PRICE_STARTER_ANNUAL",
  "STRIPE_PRICE_GROWTH_ANNUAL",
  "STRIPE_PRICE_SCALE_ANNUAL",
]

export async function verifyStripeReleaseObjects(values, {
  stage = "launch",
  fetchImpl = fetch,
} = {}) {
  const results = []
  const secretKey = String(values.STRIPE_SECRET_KEY || "").trim()
  const portalConfigurationId = String(values.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID || "").trim()
  const expectedLivemode = stage === "launch"
  const configuredPrices = priceContract.map((contract) => ({
    ...contract,
    id: String(values[contract.env] || "").trim(),
  }))
  const currentIds = configuredPrices.map((price) => price.id)
  const legacyIds = legacyPriceKeys.map((key) => String(values[key] || "").trim()).filter(Boolean)

  results.push(result(
    currentIds.every(Boolean) && new Set(currentIds).size === currentIds.length,
    "Stripe has six distinct current public Price IDs",
  ))
  results.push(result(
    currentIds.every((id) => !legacyIds.includes(id)),
    "Current public Stripe Prices are disjoint from every configured legacy Price ID",
  ))
  if (!secretKey || !portalConfigurationId || currentIds.some((id) => !id)) return results

  try {
    const prices = await Promise.all(configuredPrices.map(async (contract) => ({
      contract,
      object: await stripeGet(`/v1/prices/${encodeURIComponent(contract.id)}`, secretKey, fetchImpl),
    })))
    const productIds = [...new Set(prices.map(({ object }) => stringId(object.product)))]
    const products = await Promise.all(productIds.map(async (id) => ({
      id,
      object: await stripeGet(`/v1/products/${encodeURIComponent(id)}`, secretKey, fetchImpl),
    })))
    const portal = await stripeGet(
      `/v1/billing_portal/configurations/${encodeURIComponent(portalConfigurationId)}?expand%5B%5D=features.subscription_update.products`,
      secretKey,
      fetchImpl,
    )

    const productById = new Map(products.map((item) => [item.id, item.object]))
    for (const { contract, object: price } of prices) {
      const productId = stringId(price.product)
      const product = productById.get(productId)
      const priceValid = price.id === contract.id
        && price.active === true
        && price.livemode === expectedLivemode
        && price.currency === "eur"
        && price.type === "recurring"
        && price.billing_scheme === "per_unit"
        && price.unit_amount === contract.amount
        && price.recurring?.interval === contract.stripeInterval
        && price.recurring?.interval_count === 1
        && price.recurring?.usage_type === "licensed"
        && price.metadata?.billing_contract_version === currentContractVersion
        && price.metadata?.maintainflow_plan === contract.plan
        && price.metadata?.billing_interval === contract.interval
      results.push(result(
        priceValid,
        `${contract.plan} ${contract.interval} Stripe Price is active EUR recurring provider truth at the locked amount`,
      ))

      const expectedName = `Maintain Flow ${titleCase(contract.plan)}`
      const productValid = product?.active === true
        && product?.livemode === expectedLivemode
        && product?.name === expectedName
        && product?.metadata?.billing_contract_version === currentContractVersion
        && product?.metadata?.maintainflow_plan === contract.plan
      results.push(result(
        productValid,
        `${contract.plan} Stripe Product is active and bound to ${currentContractVersion}`,
      ))
    }

    const productsByPlan = new Map()
    let everyPlanUsesOneProduct = true
    for (const { contract, object: price } of prices) {
      const productId = stringId(price.product)
      const current = productsByPlan.get(contract.plan) ?? { productId, prices: [] }
      if (current.productId !== productId) everyPlanUsesOneProduct = false
      current.prices.push(contract.id)
      productsByPlan.set(contract.plan, current)
    }
    const portalProducts = Array.isArray(portal.features?.subscription_update?.products)
      ? portal.features.subscription_update.products
      : []
    const portalPriceIds = portalProducts.flatMap((item) => Array.isArray(item.prices) ? item.prices : [])
    const expectedProductIds = [...productsByPlan.values()].map((item) => item.productId).sort()
    const actualProductIds = portalProducts.map((item) => String(item.product || "")).sort()
    const exactPortalPlanProducts = everyPlanUsesOneProduct
      && [...productsByPlan.values()].every((expected) => {
        const actual = portalProducts.find((item) => item.product === expected.productId)
        return actual && sameStrings(
          [...(Array.isArray(actual.prices) ? actual.prices : [])].sort(),
          [...expected.prices].sort(),
        )
      })
    const portalValid = portal.id === portalConfigurationId
      && portal.active === true
      && portal.livemode === expectedLivemode
      && portal.features?.payment_method_update?.enabled === true
      && portal.features?.subscription_cancel?.enabled === true
      && portal.features?.subscription_update?.enabled === true
      && portal.features.subscription_update.default_allowed_updates?.includes("price")
      && sameStrings(actualProductIds, expectedProductIds)
      && sameStrings([...portalPriceIds].sort(), [...currentIds].sort())
      && exactPortalPlanProducts
      && portal.business_profile?.terms_of_service_url === "https://www.maintainflow.io/terms"
      && portal.business_profile?.privacy_policy_url === "https://www.maintainflow.io/privacy"
    results.push(result(
      portalValid,
      "Stripe Customer Portal is active for payment updates, cancellation and only the six current plan-change Prices",
    ))
  } catch {
    results.push(result(false, "Stripe Price, Product and Customer Portal objects were retrieved read-only and verified"))
  }

  return results
}

async function stripeGet(path, secretKey, fetchImpl) {
  const response = await fetchImpl(`https://api.stripe.com${path}`, {
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": stripeApiVersion,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error("Stripe release object could not be retrieved.")
  }
  return payload
}

function stringId(value) {
  return typeof value === "string" ? value : String(value?.id || "")
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function result(ok, message) {
  return { level: ok ? "OK" : "BLOCK", message }
}
