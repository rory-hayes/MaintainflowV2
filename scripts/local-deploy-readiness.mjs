import { spawnSync } from "node:child_process"
import { createPrivateKey } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { isIP } from "node:net"
import { evaluateSupabaseAuthReadiness } from "./lib/auth-readiness.mjs"

const env = {
  ...readEnvFile(".env.local"),
  ...process.env,
}
const releaseStage = process.argv.find((argument) => argument.startsWith("--stage="))?.slice("--stage=".length) || "launch"
if (!new Set(["canary", "launch"]).has(releaseStage)) throw new Error("--stage must be canary or launch")

const canonicalGitRemote = "https://github.com/rory-hayes/MaintainflowV2.git"
const canonicalVercelProject = "maintainflow-v2"
const canonicalVercelDashboardPath = "rorys-projects-accf0d71/maintainflow-v2"

const requiredEnvKeys = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "CRON_SECRET",
  "CHECK_RUNNER_BATCH_SIZE",
  "CHECK_RUNNER_LEASE_SECONDS",
]

const optionalEnvKeys = [
  "MAINTAINFLOW_MIGRATION_PHASE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NEXT_PUBLIC_EMAIL_PASSWORD_AUTH_ENABLED",
  "NEXT_PUBLIC_SUPABASE_AUTH_URL",
  "SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED",
  "SUPABASE_AUTH_SMTP_CONFIRMED",
  "SUPABASE_AUTH_SMTP_SENDER",
  "SUPABASE_AUTH_REDIRECTS_CONFIRMED",
  "SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED",
  "SUPABASE_AUTH_PASSWORD_MIN_LENGTH",
  "SUPABASE_PRODUCTION_PLAN_CONFIRMED",
  "VERCEL_COMMERCIAL_PLAN_CONFIRMED",
  "BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_GROWTH",
  "STRIPE_PRICE_SCALE",
  "STRIPE_PRICE_STARTER_ANNUAL",
  "STRIPE_PRICE_GROWTH_ANNUAL",
  "STRIPE_PRICE_SCALE_ANNUAL",
  "STRIPE_PRICE_SOLO",
  "STRIPE_PRICE_TEAM",
  "STRIPE_PRICE_AGENCY",
  "STRIPE_PRICE_SOLO_ANNUAL",
  "STRIPE_PRICE_TEAM_ANNUAL",
  "STRIPE_PRICE_AGENCY_ANNUAL",
  "STRIPE_LEGACY_PRICE_STARTER",
  "STRIPE_LEGACY_PRICE_GROWTH",
  "STRIPE_LEGACY_PRICE_SCALE",
  "STRIPE_LEGACY_PRICE_STARTER_ANNUAL",
  "STRIPE_LEGACY_PRICE_GROWTH_ANNUAL",
  "STRIPE_LEGACY_PRICE_SCALE_ANNUAL",
  "NEXT_PUBLIC_BUSINESS_EVALS_UI",
  "BUSINESS_EVALS_WORKSPACE_ALLOWLIST",
  "BUSINESS_EVALS_RUNNER_ENABLED",
  "BUSINESS_EVALS_RUNNER_KILL_SWITCH",
  "BUSINESS_EVALS_SCHEDULER_KILL_SWITCH",
  "BUSINESS_EVALS_SCHEDULER_BATCH_SIZE",
  "BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS",
  "BUSINESS_EVALS_FIXTURES_ENABLED",
  "BUSINESS_EVALS_FIXTURE_FROM_EMAIL",
  "BUSINESS_EVALS_FIXTURE_SIGNING_SECRET",
  "OPENAI_API_KEY",
  "BUSINESS_EVALS_AI_MODEL",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSERBASE_EGRESS_PROXY_SERVER",
  "BROWSERBASE_EGRESS_PROXY_USERNAME",
  "BROWSERBASE_EGRESS_PROXY_PASSWORD",
  "RESEND_API_KEY",
  "RESEND_INBOUND_WEBHOOK_SECRET",
  "EVAL_INBOUND_DOMAIN",
  "EVAL_EMAIL_ROUTING_SECRET",
  "EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64",
  "EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64",
  "EVAL_CLEANUP_SIGNING_KEY_ID",
  "REPORT_SHARE_TOKEN_PEPPER",
  "RUN_LOG_KEY_PEPPER",
  "ALERT_ENDPOINT_ENCRYPTION_KEY",
  "MAINTAINFLOW_ALERT_FROM_EMAIL",
  "ALERT_DELIVERY_BATCH_SIZE",
  "STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID",
  "STRIPE_CUSTOMER_PORTAL_ENABLED",
  "NEXT_PUBLIC_SENTRY_DSN",
]

const results = []

checkEnvironmentSource()
checkFile("supabase/maintainflow_schema.sql", "Supabase schema SQL exists")
checkFile("supabase/maintainflow_scheduler.sql", "Supabase scheduler SQL exists")
checkFile("supabase/maintainflow_scheduler_verify.sql", "Supabase scheduler verification SQL exists")
checkFile("scripts/push-vercel-env.mjs", "Vercel env push helper exists")

checkRequiredEnv()
checkSupabaseUrl()
checkSupabaseAuthReadiness()
checkInfrastructurePlanReadiness()
checkCronSettings()
checkBusinessEvalsProviderEnv()
checkStripeBillingEnv()
checkCommand("git", ["--version"], "Git is available")
const ghAvailable = checkCommand("gh", ["--version"], "GitHub CLI is available", { optional: true })
if (ghAvailable) checkGhAuth()
const vercelAvailable = checkCommand("pnpm", ["dlx", "vercel@56.3.2", "--version"], "Pinned Vercel CLI is available for scripted env pushes", {
  optional: true,
})
if (vercelAvailable) checkVercelAuth()
checkGitRemote()
checkVercelProjectLink()
checkEnvIgnored()
checkGitMetadataWritable()

for (const result of results) {
  console.log(`${result.level.padEnd(5)} ${result.message}`)
}

const blockers = results.filter((result) => result.level === "BLOCK")
const warnings = results.filter((result) => result.level === "WARN")

console.log("")
console.log(`Deployment readiness (${releaseStage}): ${blockers.length ? "blocked" : "ready with local checks"}`)
console.log(`Blockers: ${blockers.length}`)
console.log(`Warnings: ${warnings.length}`)

if (blockers.length) {
  process.exitCode = 1
}

function checkFile(path, message) {
  add(existsSync(path) ? "OK" : "BLOCK", existsSync(path) ? message : `${message}: missing`)
}

function checkEnvironmentSource() {
  const localEnvExists = existsSync(".env.local")
  const requiredEnvironmentInjected = requiredEnvKeys.every((key) => Boolean(process.env[key]))
  add(
    localEnvExists || requiredEnvironmentInjected ? "OK" : "BLOCK",
    localEnvExists
      ? ".env.local exists"
      : requiredEnvironmentInjected
        ? "Required environment is securely injected without .env.local"
        : ".env.local is missing and the required environment is not injected"
  )
}

function checkRequiredEnv() {
  const missing = requiredEnvKeys.filter((key) => !env[key])
  add(missing.length ? "BLOCK" : "OK", missing.length ? `Missing required env keys: ${missing.join(", ")}` : "Required deployment env keys are present")

  const presentOptional = optionalEnvKeys.filter((key) => env[key])
  add("OK", `Optional provider env keys present: ${presentOptional.length ? presentOptional.join(", ") : "none"}`)
}

function checkSupabaseUrl() {
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || ""
  const supabaseAuthUrl = env.NEXT_PUBLIC_SUPABASE_AUTH_URL || ""

  if (!supabaseUrl) return
  if (supabaseUrl.includes("/rest/v1")) {
    add("BLOCK", "NEXT_PUBLIC_SUPABASE_URL must be the Supabase project base URL, not the /rest/v1 endpoint")
    return
  }

  add(supabaseUrl.startsWith("https://") ? "OK" : "BLOCK", "NEXT_PUBLIC_SUPABASE_URL uses an HTTPS project URL")

  if (!supabaseAuthUrl) {
    add("WARN", "NEXT_PUBLIC_SUPABASE_AUTH_URL is not set; hosted OAuth prompts may show the Supabase project domain")
    return
  }

  if (supabaseAuthUrl.includes("/auth/v1") || supabaseAuthUrl.includes("/rest/v1")) {
    add("BLOCK", "NEXT_PUBLIC_SUPABASE_AUTH_URL must be the branded Supabase auth base URL, not an /auth/v1 or /rest/v1 endpoint")
    return
  }

  add(supabaseAuthUrl.startsWith("https://") ? "OK" : "BLOCK", "NEXT_PUBLIC_SUPABASE_AUTH_URL uses an HTTPS auth base URL")
}

function checkSupabaseAuthReadiness() {
  for (const result of evaluateSupabaseAuthReadiness(env, { releaseStage })) {
    add(result.level, result.message)
  }
}

function checkInfrastructurePlanReadiness() {
  const requirements = [
    ["SUPABASE_PRODUCTION_PLAN_CONFIRMED", "Supabase Pro or higher is confirmed for automatic backups and no inactivity pausing"],
    ["VERCEL_COMMERCIAL_PLAN_CONFIRMED", "Vercel Pro or higher is confirmed for commercial production use"],
    ["BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED", "Browserbase Developer or higher is confirmed for custom-proxy sessions"],
  ]
  for (const [key, successMessage] of requirements) {
    add(env[key] === "true" ? "OK" : "BLOCK", env[key] === "true" ? successMessage : `${key} must be true after the provider plan is active and verified`)
  }
}

function checkCronSettings() {
  const batchSize = Number(env.CHECK_RUNNER_BATCH_SIZE)
  const leaseSeconds = Number(env.CHECK_RUNNER_LEASE_SECONDS)
  const batchSizeValid = batchSize === 5
  const leaseSecondsValid = Number.isInteger(leaseSeconds) && leaseSeconds >= 120 && leaseSeconds <= 900
  const cronSecretValid = (env.CRON_SECRET || "").length >= 32

  add(batchSizeValid ? "OK" : "BLOCK", batchSizeValid ? "CHECK_RUNNER_BATCH_SIZE is 5 for each bounded parallel scheduler worker" : "CHECK_RUNNER_BATCH_SIZE must be 5")
  add(leaseSecondsValid ? "OK" : "BLOCK", leaseSecondsValid ? "CHECK_RUNNER_LEASE_SECONDS is between 120 and 900 seconds" : "CHECK_RUNNER_LEASE_SECONDS must be between 120 and 900 seconds")
  add(cronSecretValid ? "OK" : "BLOCK", cronSecretValid ? "CRON_SECRET contains at least 32 characters" : "CRON_SECRET must contain at least 32 characters")
}

function checkBusinessEvalsProviderEnv() {
  const uiEnabled = env.NEXT_PUBLIC_BUSINESS_EVALS_UI === "true"
  const runnerEnabled = env.BUSINESS_EVALS_RUNNER_ENABLED === "true"
  const stagedWorkspaceAllowlist = (env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const required = [
    "OPENAI_API_KEY",
    "BROWSERBASE_API_KEY",
    "BROWSERBASE_PROJECT_ID",
    "BROWSERBASE_EGRESS_PROXY_SERVER",
    "BROWSERBASE_EGRESS_PROXY_USERNAME",
    "BROWSERBASE_EGRESS_PROXY_PASSWORD",
    "RESEND_API_KEY",
    "RESEND_INBOUND_WEBHOOK_SECRET",
    "EVAL_INBOUND_DOMAIN",
    "EVAL_EMAIL_ROUTING_SECRET",
    "EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64",
    "EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64",
    "EVAL_CLEANUP_SIGNING_KEY_ID",
    "REPORT_SHARE_TOKEN_PEPPER",
    "RUN_LOG_KEY_PEPPER",
    "ALERT_ENDPOINT_ENCRYPTION_KEY",
    "MAINTAINFLOW_ALERT_FROM_EMAIL",
    "ALERT_DELIVERY_BATCH_SIZE",
  ]
  const missing = required.filter((key) => !env[key])
  add(
    missing.length ? "BLOCK" : "OK",
    missing.length ? `Business Evals production providers are incomplete: ${missing.join(", ")}` : "Business Evals production provider keys are present"
  )
  if (releaseStage === "launch") {
    add(uiEnabled ? "OK" : "BLOCK", uiEnabled ? "Business Evals authenticated UI is enabled for the production release" : "NEXT_PUBLIC_BUSINESS_EVALS_UI must be true for the production release")
    add(stagedWorkspaceAllowlist.length === 0 ? "OK" : "BLOCK", stagedWorkspaceAllowlist.length === 0 ? "Global release does not retain a stale workspace allowlist" : "BUSINESS_EVALS_WORKSPACE_ALLOWLIST must be empty for the global release")
  } else {
    add(!uiEnabled ? "OK" : "BLOCK", !uiEnabled ? "Global Business Evals UI remains disabled during the selected-workspace canary" : "NEXT_PUBLIC_BUSINESS_EVALS_UI must remain false during the selected-workspace canary")
    add(stagedWorkspaceAllowlist.length > 0 ? "OK" : "BLOCK", stagedWorkspaceAllowlist.length > 0 ? "A selected-workspace canary allowlist is configured" : "BUSINESS_EVALS_WORKSPACE_ALLOWLIST must contain at least one canary workspace")
  }
  add(runnerEnabled ? "OK" : "BLOCK", runnerEnabled ? "Business Evals runner is enabled for the production release" : "BUSINESS_EVALS_RUNNER_ENABLED must be true for the production release")
  if (env.EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64) {
    add(
      isExactBase64Key(env.EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64, 32) ? "OK" : "BLOCK",
      "EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64 is canonical base64 for exactly 32 bytes"
    )
  }
  for (const key of ["RESEND_INBOUND_WEBHOOK_SECRET", "EVAL_EMAIL_ROUTING_SECRET", "REPORT_SHARE_TOKEN_PEPPER", "RUN_LOG_KEY_PEPPER", "ALERT_ENDPOINT_ENCRYPTION_KEY"]) {
    if (env[key]) add(env[key].trim().length >= 32 ? "OK" : "BLOCK", `${key} contains at least 32 characters`)
  }
  if (env.EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 || env.EVAL_CLEANUP_SIGNING_KEY_ID) {
    for (const result of validateCleanupSigningKey(env)) add(result.level, result.message)
  }
  if (env.EVAL_INBOUND_DOMAIN) {
    add(isPublicHostname(env.EVAL_INBOUND_DOMAIN) ? "OK" : "BLOCK", "EVAL_INBOUND_DOMAIN is a public DNS hostname")
  }
  if (env.MAINTAINFLOW_ALERT_FROM_EMAIL) {
    add(/^[^\s@]+@maintainflow\.io$/i.test(env.MAINTAINFLOW_ALERT_FROM_EMAIL.trim()) ? "OK" : "BLOCK", "MAINTAINFLOW_ALERT_FROM_EMAIL uses a verified @maintainflow.io sender")
  }
  if (!missing.some((key) => key.startsWith("BROWSERBASE_EGRESS_PROXY_"))) {
    for (const result of validateBrowserbaseEgressProxy(env)) add(result.level, result.message)
  }
  add(
    env.BUSINESS_EVALS_RUNNER_KILL_SWITCH === "false" ? "OK" : "BLOCK",
    env.BUSINESS_EVALS_RUNNER_KILL_SWITCH === "false" ? "Business Evals runner kill switch is explicitly open" : "BUSINESS_EVALS_RUNNER_KILL_SWITCH must be false after the production canary passes"
  )
  add(
    env.BUSINESS_EVALS_SCHEDULER_KILL_SWITCH === "false" ? "OK" : "BLOCK",
    env.BUSINESS_EVALS_SCHEDULER_KILL_SWITCH === "false" ? "Business Evals scheduler kill switch is explicitly open" : "BUSINESS_EVALS_SCHEDULER_KILL_SWITCH must be false after the production canary passes"
  )
  const fixturesEnabled = env.BUSINESS_EVALS_FIXTURES_ENABLED === "true"
  add(
    releaseStage === "canary" ? (fixturesEnabled ? "OK" : "BLOCK") : (env.BUSINESS_EVALS_FIXTURES_ENABLED === "false" ? "OK" : "BLOCK"),
    releaseStage === "canary"
      ? (fixturesEnabled ? "Controlled fixture routes are enabled for the bounded canary" : "BUSINESS_EVALS_FIXTURES_ENABLED must be true for the bounded canary")
      : (env.BUSINESS_EVALS_FIXTURES_ENABLED === "false" ? "Controlled Business Evals fixture routes are disabled for launch" : "BUSINESS_EVALS_FIXTURES_ENABLED must be false at launch")
  )
  if (releaseStage === "canary") {
    const fixtureSigningSecretValid = (env.BUSINESS_EVALS_FIXTURE_SIGNING_SECRET || "").trim().length >= 32
    add(
      fixtureSigningSecretValid ? "OK" : "BLOCK",
      fixtureSigningSecretValid ? "BUSINESS_EVALS_FIXTURE_SIGNING_SECRET contains at least 32 characters for the bounded canary" : "BUSINESS_EVALS_FIXTURE_SIGNING_SECRET must contain at least 32 characters for the bounded canary"
    )
    const fixtureFromEmail = (env.BUSINESS_EVALS_FIXTURE_FROM_EMAIL || env.MAINTAINFLOW_ALERT_FROM_EMAIL || "").trim()
    const fixtureFromEmailValid = /^[^\s@]+@maintainflow\.io$/i.test(fixtureFromEmail)
    add(
      fixtureFromEmailValid ? "OK" : "BLOCK",
      fixtureFromEmailValid ? "Controlled fixture email uses a verified @maintainflow.io sender" : "Controlled fixture email must use a verified @maintainflow.io sender"
    )
  }
  const schedulerBatch = Number(env.BUSINESS_EVALS_SCHEDULER_BATCH_SIZE)
  const schedulerLease = Number(env.BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS)
  const alertBatch = Number(env.ALERT_DELIVERY_BATCH_SIZE)
  const schedulerBatchValid = Number.isInteger(schedulerBatch) && schedulerBatch >= 1 && schedulerBatch <= 25
  const schedulerLeaseValid = Number.isInteger(schedulerLease) && schedulerLease >= 120 && schedulerLease <= 900
  const alertBatchValid = Number.isInteger(alertBatch) && alertBatch >= 1 && alertBatch <= 100
  add(schedulerBatchValid ? "OK" : "BLOCK", schedulerBatchValid ? "Business Evals scheduler batch size is between 1 and 25" : "BUSINESS_EVALS_SCHEDULER_BATCH_SIZE must be between 1 and 25")
  add(schedulerLeaseValid ? "OK" : "BLOCK", schedulerLeaseValid ? "Business Evals scheduler lease is between 120 and 900 seconds" : "BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS must be between 120 and 900 seconds")
  add(alertBatchValid ? "OK" : "BLOCK", alertBatchValid ? "Alert delivery batch size is between 1 and 100" : "ALERT_DELIVERY_BATCH_SIZE must be between 1 and 100")
}

function isExactBase64Key(value, expectedBytes) {
  const normalized = String(value || "").trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false
  const decoded = Buffer.from(normalized, "base64")
  return decoded.length === expectedBytes
    && decoded.toString("base64").replace(/=+$/, "") === normalized.replace(/=+$/, "")
}

function validateBrowserbaseEgressProxy(values) {
  const results = []
  let proxyUrl
  try {
    proxyUrl = new URL((values.BROWSERBASE_EGRESS_PROXY_SERVER || "").trim())
  } catch {
    return [{ level: "BLOCK", message: "BROWSERBASE_EGRESS_PROXY_SERVER is not a valid HTTPS proxy origin" }]
  }

  const hostname = proxyUrl.hostname.toLowerCase()
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, "")
  const reservedSuffixes = [".localhost", ".local", ".internal", ".home", ".lan", ".test", ".invalid", ".onion"]
  const originOnly = proxyUrl.pathname === "/" && !proxyUrl.search && !proxyUrl.hash
  const publicHostname = hostname
    && hostname.includes(".")
    && hostname !== "localhost"
    && !reservedSuffixes.some((suffix) => hostname.endsWith(suffix))
    && !isIP(unbracketedHostname)
  results.push({
    level: proxyUrl.protocol === "https:" && !proxyUrl.username && !proxyUrl.password && originOnly && publicHostname ? "OK" : "BLOCK",
    message: "Browserbase egress proxy is a credential-free HTTPS origin on a public DNS hostname",
  })
  results.push({
    level: /^\S{1,256}$/.test((values.BROWSERBASE_EGRESS_PROXY_USERNAME || "").trim()) ? "OK" : "BLOCK",
    message: "Browserbase egress proxy username is present and structurally safe",
  })
  const passwordLength = (values.BROWSERBASE_EGRESS_PROXY_PASSWORD || "").trim().length
  results.push({
    level: passwordLength >= 16 && passwordLength <= 1_024 ? "OK" : "BLOCK",
    message: "Browserbase egress proxy password meets the 16-character minimum",
  })
  return results
}

function validateCleanupSigningKey(values) {
  const keyId = (values.EVAL_CLEANUP_SIGNING_KEY_ID || "").trim()
  const encoded = (values.EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 || "").trim()
  const results = [{
    level: /^[A-Za-z0-9._-]{3,64}$/.test(keyId) ? "OK" : "BLOCK",
    message: "EVAL_CLEANUP_SIGNING_KEY_ID is a stable 3-64 character identifier",
  }]
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" })
    results.push({
      level: privateKey.asymmetricKeyType === "ed25519" ? "OK" : "BLOCK",
      message: "EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 is a PKCS#8 Ed25519 private key",
    })
  } catch {
    results.push({ level: "BLOCK", message: "EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 is a PKCS#8 Ed25519 private key" })
  }
  return results
}

function isPublicHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "")
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
    && !hostname.endsWith(".localhost")
    && !hostname.endsWith(".local")
    && !hostname.endsWith(".internal")
    && !hostname.endsWith(".test")
    && !hostname.endsWith(".invalid")
}

function checkStripeBillingEnv() {
  const portalConfigurationId = (env.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID || "").trim()
  const requiredStripeBillingKeys = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_SOLO",
    "STRIPE_PRICE_TEAM",
    "STRIPE_PRICE_AGENCY",
    "STRIPE_PRICE_SOLO_ANNUAL",
    "STRIPE_PRICE_TEAM_ANNUAL",
    "STRIPE_PRICE_AGENCY_ANNUAL",
  ]
  const present = requiredStripeBillingKeys.filter((key) => env[key])
  const missing = requiredStripeBillingKeys.filter((key) => !env[key])

  if (!present.length) {
    add("BLOCK", "Stripe billing env keys are required for the self-serve production release")
    return
  }

  add(
    missing.length ? "BLOCK" : "OK",
    missing.length
      ? `Stripe billing env is partial; missing ${missing.join(", ")}`
      : "Stripe billing env keys are present"
  )
  const annualPricesComplete = ["STRIPE_PRICE_SOLO_ANNUAL", "STRIPE_PRICE_TEAM_ANNUAL", "STRIPE_PRICE_AGENCY_ANNUAL"].every((key) => Boolean(env[key]))
  add(annualPricesComplete ? "OK" : "BLOCK", annualPricesComplete ? "Stable annual Stripe Prices are configured for every public paid plan" : "Stable annual Stripe Prices must be configured for every public paid plan")
  add(
    env.STRIPE_CUSTOMER_PORTAL_ENABLED === "true" ? "OK" : "BLOCK",
    env.STRIPE_CUSTOMER_PORTAL_ENABLED === "true"
      ? "Stripe Customer Portal is explicitly enabled"
      : "STRIPE_CUSTOMER_PORTAL_ENABLED must be true only after the active portal configuration is verified"
  )
  add(
    portalConfigurationId ? "OK" : "BLOCK",
    portalConfigurationId
      ? "Stripe Customer Portal configuration ID is present"
      : "STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID must identify the verified portal configuration"
  )
  for (const result of validateStripeReleaseValues(env, releaseStage)) add(result.level, result.message)
}

function validateStripeReleaseValues(values, stage) {
  const results = []
  const secretKey = (values.STRIPE_SECRET_KEY || "").trim()
  const expectedMode = stage === "launch" ? "live" : "test"
  const secretKeyValid = new RegExp(`^(?:sk|rk)_${expectedMode}_[A-Za-z0-9]+$`).test(secretKey)
  results.push({
    level: secretKeyValid ? "OK" : "BLOCK",
    message: secretKeyValid ? `Stripe ${expectedMode}-mode secret or restricted key is configured for the ${stage} stage` : `STRIPE_SECRET_KEY must use a Stripe ${expectedMode}-mode secret or restricted key for the ${stage} stage`,
  })
  const webhookSecretValid = /^whsec_[A-Za-z0-9_]+$/.test((values.STRIPE_WEBHOOK_SECRET || "").trim())
  results.push({
    level: webhookSecretValid ? "OK" : "BLOCK",
    message: webhookSecretValid ? "STRIPE_WEBHOOK_SECRET has Stripe webhook-secret structure" : "STRIPE_WEBHOOK_SECRET must have Stripe webhook-secret structure",
  })
  const portalConfigurationValid = /^bpc_[A-Za-z0-9]+$/.test((values.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID || "").trim())
  results.push({
    level: portalConfigurationValid ? "OK" : "BLOCK",
    message: portalConfigurationValid ? "STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID has Stripe portal-configuration structure" : "STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID must have Stripe portal-configuration structure",
  })
  const priceKeys = [
    "STRIPE_PRICE_SOLO",
    "STRIPE_PRICE_TEAM",
    "STRIPE_PRICE_AGENCY",
    "STRIPE_PRICE_SOLO_ANNUAL",
    "STRIPE_PRICE_TEAM_ANNUAL",
    "STRIPE_PRICE_AGENCY_ANNUAL",
  ]
  const priceIds = priceKeys.map((key) => (values[key] || "").trim())
  const priceStructureValid = priceIds.every((value) => /^price_[A-Za-z0-9]+$/.test(value))
  results.push({
    level: priceStructureValid ? "OK" : "BLOCK",
    message: priceStructureValid ? "Every public monthly and annual Stripe Price has Stripe Price ID structure" : "Every public monthly and annual Stripe Price must use a Stripe price_ ID",
  })
  const priceIdsDistinct = priceIds.every(Boolean) && new Set(priceIds).size === priceIds.length
  results.push({
    level: priceIdsDistinct ? "OK" : "BLOCK",
    message: priceIdsDistinct ? "Every public monthly and annual Stripe Price ID is distinct" : "Every public monthly and annual Stripe Price ID must be distinct",
  })
  return results
}

function checkCommand(command, args, message, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" })

  if (result.status === 0) {
    add("OK", message)
    return true
  }

  if (options.blockOnMissing) {
    add("BLOCK", `${message}: missing or not on PATH`)
    return false
  }

  add(options.optional ? "WARN" : "BLOCK", `${message}: missing or not on PATH`)
  return false
}

function checkGhAuth() {
  const result = spawnSync("gh", ["auth", "status"], { encoding: "utf8" })
  add(
    result.status === 0 ? "OK" : "WARN",
    result.status === 0
      ? "GitHub CLI authentication is valid"
      : "GitHub CLI authentication could not be verified in this session"
  )
}

function checkVercelAuth() {
  const result = spawnSync("pnpm", ["dlx", "vercel@56.3.2", "whoami"], { encoding: "utf8" })
  add(result.status === 0 ? "OK" : "BLOCK", "Vercel CLI authentication is valid")
}

function checkGitRemote() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" })

  if (result.status !== 0) {
    add("BLOCK", "Git origin remote is not configured")
    return
  }

  const remote = result.stdout.trim()
  add(
    remote === canonicalGitRemote ? "OK" : "BLOCK",
    remote === canonicalGitRemote
      ? `Git origin matches the canonical V2 repository: ${remote}`
      : `Git origin must be ${canonicalGitRemote}; found ${remote || "missing"}`
  )
}

function checkVercelProjectLink() {
  const projectFile = ".vercel/project.json"

  if (!existsSync(projectFile)) {
    add("BLOCK", `Vercel project link is missing; link ${canonicalVercelDashboardPath}`)
    return
  }

  try {
    const project = JSON.parse(readFileSync(projectFile, "utf8"))
    add(
      project.projectName === canonicalVercelProject ? "OK" : "BLOCK",
      project.projectName === canonicalVercelProject
        ? `Vercel project link targets ${canonicalVercelDashboardPath}`
        : `Vercel project link must target ${canonicalVercelDashboardPath}; found ${project.projectName || "missing"}`
    )
  } catch {
    add("BLOCK", `${projectFile} is not valid Vercel project metadata for ${canonicalVercelDashboardPath}`)
  }
}

function checkEnvIgnored() {
  const result = spawnSync("git", ["check-ignore", "-q", ".env.local"], { encoding: "utf8" })
  add(result.status === 0 ? "OK" : "BLOCK", ".env.local is ignored by git")
}

function checkGitMetadataWritable() {
  const probe = ".git/codex-write-test"

  try {
    writeFileSync(probe, "local readiness probe\n", { flag: "wx" })
    rmSync(probe, { force: true })
    add("OK", ".git metadata is writable for staging and committing")
  } catch {
    add("WARN", ".git metadata is not writable in this session; staging and committing may require a less restricted shell")
  }
}

function add(level, message) {
  results.push({ level, message })
}

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=")
          return [line.slice(0, separator), stripQuotes(line.slice(separator + 1))]
        })
    )
  } catch {
    return {}
  }
}

function stripQuotes(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  return value
}
