import { spawnSync } from "node:child_process"
import { createPrivateKey } from "node:crypto"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { evaluateSupabaseAuthReadiness } from "./lib/auth-readiness.mjs"

const env = {
  ...readEnvFile(".env.local"),
  ...process.env,
}
const lockedVercelProjectId = "prj_zbbXA1ZH26G9YAL8sNtEkxHy1AwE"
const lockedVercelTeamSlug = "rorys-projects-accf0d71"

if (env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID !== lockedVercelProjectId) {
  throw new Error(`VERCEL_PROJECT_ID must be the locked Maintain Flow V2 project ${lockedVercelProjectId}.`)
}
if (env.VERCEL_TEAM_SLUG && env.VERCEL_TEAM_SLUG !== lockedVercelTeamSlug) {
  throw new Error(`VERCEL_TEAM_SLUG must be the locked Maintain Flow V2 team ${lockedVercelTeamSlug}.`)
}

if (process.argv.includes("--all")) {
  throw new Error("Bulk environment publishing is disabled. Maintain Flow production credentials must not be copied into Preview or Development.")
}

const environment = readFlag("--environment") || "production"
if (environment !== "production") {
  throw new Error("This helper is production-only. Configure Preview and Development from separate, environment-specific sources.")
}
const environments = [environment]
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--check")
const releaseStage = readFlag("--stage") || "launch"
if (!new Set(["canary", "launch"]).has(releaseStage)) throw new Error("--stage must be canary or launch")

const businessEvalsWorkspaceAllowlist = (env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
const businessEvalsCutoverKeys = [
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
]

const requiredKeys = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "CRON_SECRET",
  "CHECK_RUNNER_BATCH_SIZE",
  "CHECK_RUNNER_LEASE_SECONDS",
  "SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED",
  "SUPABASE_AUTH_SMTP_CONFIRMED",
  "SUPABASE_AUTH_SMTP_SENDER",
  "SUPABASE_AUTH_REDIRECTS_CONFIRMED",
  "SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED",
  "SUPABASE_AUTH_PASSWORD_MIN_LENGTH",
  "SUPABASE_PRODUCTION_PLAN_CONFIRMED",
  "VERCEL_COMMERCIAL_PLAN_CONFIRMED",
  "BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_SOLO",
  "STRIPE_PRICE_TEAM",
  "STRIPE_PRICE_AGENCY",
  "STRIPE_PRICE_SOLO_ANNUAL",
  "STRIPE_PRICE_TEAM_ANNUAL",
  "STRIPE_PRICE_AGENCY_ANNUAL",
  "STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID",
  "STRIPE_CUSTOMER_PORTAL_ENABLED",
  "NEXT_PUBLIC_BUSINESS_EVALS_UI",
  "BUSINESS_EVALS_RUNNER_ENABLED",
  "BUSINESS_EVALS_RUNNER_KILL_SWITCH",
  "BUSINESS_EVALS_SCHEDULER_KILL_SWITCH",
  "BUSINESS_EVALS_SCHEDULER_BATCH_SIZE",
  "BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS",
  "BUSINESS_EVALS_FIXTURES_ENABLED",
  "ALERT_DELIVERY_BATCH_SIZE",
  ...businessEvalsCutoverKeys,
]
if (releaseStage === "canary") {
  requiredKeys.push("BUSINESS_EVALS_WORKSPACE_ALLOWLIST", "BUSINESS_EVALS_FIXTURE_SIGNING_SECRET")
}

const optionalKeys = [
  "MAINTAINFLOW_MIGRATION_PHASE",
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
  "BUSINESS_EVALS_DOMAIN_DENYLIST",
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
  "EVAL_SYNTHETIC_EMAIL_DOMAIN",
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
  "MAINTAINFLOW_OPS_ROUTE_KEY",
  "OPS_ADMIN_EMAILS",
]

const keysToRemove = releaseStage === "launch"
  ? ["BUSINESS_EVALS_WORKSPACE_ALLOWLIST", "BUSINESS_EVALS_FIXTURE_SIGNING_SECRET", "BUSINESS_EVALS_FIXTURE_FROM_EMAIL"]
  : []
const keys = [...new Set([...requiredKeys, ...optionalKeys])]
  .filter((key) => env[key] && !keysToRemove.includes(key))
const missing = requiredKeys.filter((key) => !env[key])
if (missing.length) {
  throw new Error(`Missing required env vars in .env.local: ${missing.join(", ")}`)
}
validateProductionReleaseValues(env, releaseStage)

if (dryRun) {
  const presentOptionalKeys = optionalKeys.filter((key) => env[key])
  const missingOptionalKeys = optionalKeys.filter((key) => !env[key])

  console.log(`Vercel env dry run for environments: ${environments.join(", ")}`)
  console.log(`Release stage: ${releaseStage}`)
  console.log(`Required keys present: ${requiredKeys.join(", ")}`)
  console.log(`Optional keys present: ${presentOptionalKeys.length ? presentOptionalKeys.join(", ") : "none"}`)
  console.log(`Optional keys missing: ${missingOptionalKeys.length ? missingOptionalKeys.join(", ") : "none"}`)
  console.log(`Keys removed for this stage: ${keysToRemove.length ? keysToRemove.join(", ") : "none"}`)
  console.log("Stripe Customer Portal activation keys are scoped to production.")
  console.log("No values were printed and nothing was sent to Vercel.")
  process.exit(0)
}

if (runVercel(["--version"]).status !== 0) {
  throw new Error("The pinned Vercel CLI could not start. Install pnpm dependencies, then rerun this script.")
}

const projectArgs = [
  "--project",
  lockedVercelProjectId,
  "--scope",
  lockedVercelTeamSlug,
]

console.log(`Upserting ${keys.length} env vars in Vercel environments: ${environments.join(", ")}`)
console.log("Values are piped to Vercel and are not printed.")

for (const key of keysToRemove) {
  for (const environment of environments) {
    const result = runVercel(["env", "remove", key, environment, "--yes", ...projectArgs])
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status === 0) {
      console.log(`Removed ${key} from ${environment}.`)
      continue
    }
    if (/not found|does not exist/i.test(output)) {
      console.log(`${key} is already absent from ${environment}.`)
      continue
    }
    throw new Error(`Failed to remove ${key} from ${environment}: ${redact(output)}`)
  }
}

for (const key of keys) {
  for (const environment of environments) {
    const result = runVercel(["env", "add", key, environment, "--force", "--yes", ...projectArgs], `${env[key]}\n`)

    if (result.status === 0) {
      console.log(`Upserted ${key} in ${environment}.`)
      continue
    }

    throw new Error(`Failed to upsert ${key} in ${environment}: ${redact(`${result.stdout}\n${result.stderr}`)}`)
  }
}

function runVercel(args, input) {
  return spawnSync("pnpm", ["dlx", "vercel@56.3.2", ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
}

function readFlag(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
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
          return [line.slice(0, separator), line.slice(separator + 1)]
        })
    )
  } catch {
    return {}
  }
}

function redact(value) {
  let redacted = String(value)
  for (const [key, secret] of Object.entries(env)) {
    if (
      /(?:KEY|SECRET|PASSWORD|PEPPER|TOKEN|PRIVATE|ENCRYPTION|DATABASE_URL|SERVICE_ROLE)/.test(key)
      && typeof secret === "string"
      && secret.length >= 8
    ) {
      redacted = redacted.split(secret).join("[redacted]")
    }
  }
  return redacted
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/(sb_(?:secret|publishable)_[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/(sk-proj-[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/(sk_(?:live|test)_[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/(rk_(?:live|test)_[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/(pk_(?:live|test)_[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/(whsec_[A-Za-z0-9_-]+)/g, "[redacted]")
    .replace(/(re_[A-Za-z0-9_-]{12,})/g, "[redacted]")
}

function validateBrowserbaseEgressProxy(values) {
  let proxyUrl
  try {
    proxyUrl = new URL((values.BROWSERBASE_EGRESS_PROXY_SERVER || "").trim())
  } catch {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must be a valid HTTPS proxy origin.")
  }
  const hostname = proxyUrl.hostname.toLowerCase()
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, "")
  const reservedSuffixes = [".localhost", ".local", ".internal", ".home", ".lan", ".test", ".invalid", ".onion"]
  if (
    proxyUrl.protocol !== "https:"
    || proxyUrl.username
    || proxyUrl.password
    || proxyUrl.pathname !== "/"
    || proxyUrl.search
    || proxyUrl.hash
    || !hostname
    || !hostname.includes(".")
    || hostname === "localhost"
    || reservedSuffixes.some((suffix) => hostname.endsWith(suffix))
    || isIP(unbracketedHostname)
  ) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must be a credential-free HTTPS origin on a public DNS hostname.")
  }
  if (!/^\S{1,256}$/.test((values.BROWSERBASE_EGRESS_PROXY_USERNAME || "").trim())) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_USERNAME must be present and contain no whitespace.")
  }
  const passwordLength = (values.BROWSERBASE_EGRESS_PROXY_PASSWORD || "").trim().length
  if (passwordLength < 16 || passwordLength > 1_024) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_PASSWORD must contain between 16 and 1024 characters.")
  }
}

function validateProductionReleaseValues(values, stage) {
  const authBlockers = evaluateSupabaseAuthReadiness(values, { releaseStage: stage }).filter((result) => result.level === "BLOCK")
  if (authBlockers.length) throw new Error(`Supabase Auth is not production ready: ${authBlockers.map((result) => result.message).join("; ")}`)
  for (const key of ["SUPABASE_PRODUCTION_PLAN_CONFIRMED", "VERCEL_COMMERCIAL_PLAN_CONFIRMED", "BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED"]) {
    if (values[key] !== "true") throw new Error(`${key} must be true after the provider plan is active and verified.`)
  }
  if (stage === "launch" && values.NEXT_PUBLIC_BUSINESS_EVALS_UI !== "true") throw new Error("NEXT_PUBLIC_BUSINESS_EVALS_UI must be true for the production release.")
  if (stage === "canary" && values.NEXT_PUBLIC_BUSINESS_EVALS_UI !== "false") throw new Error("NEXT_PUBLIC_BUSINESS_EVALS_UI must remain false during the selected-workspace canary.")
  if (stage === "canary" && businessEvalsWorkspaceAllowlist.length === 0) throw new Error("BUSINESS_EVALS_WORKSPACE_ALLOWLIST must contain at least one canary workspace.")
  if (stage === "launch" && businessEvalsWorkspaceAllowlist.length > 0) throw new Error("BUSINESS_EVALS_WORKSPACE_ALLOWLIST must be empty for the global release.")
  if (values.BUSINESS_EVALS_RUNNER_ENABLED !== "true") throw new Error("BUSINESS_EVALS_RUNNER_ENABLED must be true for the production release.")
  if (values.BUSINESS_EVALS_RUNNER_KILL_SWITCH !== "false") throw new Error("BUSINESS_EVALS_RUNNER_KILL_SWITCH must be false after the production canary passes.")
  if (values.BUSINESS_EVALS_SCHEDULER_KILL_SWITCH !== "false") throw new Error("BUSINESS_EVALS_SCHEDULER_KILL_SWITCH must be false after the production canary passes.")
  if (stage === "canary" && values.BUSINESS_EVALS_FIXTURES_ENABLED !== "true") throw new Error("BUSINESS_EVALS_FIXTURES_ENABLED must be true for the bounded canary.")
  if (stage === "launch" && values.BUSINESS_EVALS_FIXTURES_ENABLED !== "false") throw new Error("BUSINESS_EVALS_FIXTURES_ENABLED must remain false at launch.")
  if (values.STRIPE_CUSTOMER_PORTAL_ENABLED !== "true") throw new Error("STRIPE_CUSTOMER_PORTAL_ENABLED must be true after the verified portal configuration is connected.")

  const schedulerBatch = Number(values.BUSINESS_EVALS_SCHEDULER_BATCH_SIZE)
  const schedulerLease = Number(values.BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS)
  const alertBatch = Number(values.ALERT_DELIVERY_BATCH_SIZE)
  if ((values.CRON_SECRET || "").trim().length < 32) throw new Error("CRON_SECRET must contain at least 32 characters.")
  if (!Number.isInteger(schedulerBatch) || schedulerBatch < 1 || schedulerBatch > 25) throw new Error("BUSINESS_EVALS_SCHEDULER_BATCH_SIZE must be between 1 and 25.")
  if (!Number.isInteger(schedulerLease) || schedulerLease < 120 || schedulerLease > 900) throw new Error("BUSINESS_EVALS_SCHEDULER_LEASE_SECONDS must be between 120 and 900.")
  if (!Number.isInteger(alertBatch) || alertBatch < 1 || alertBatch > 100) throw new Error("ALERT_DELIVERY_BATCH_SIZE must be between 1 and 100.")

  for (const key of ["RESEND_INBOUND_WEBHOOK_SECRET", "EVAL_EMAIL_ROUTING_SECRET", "REPORT_SHARE_TOKEN_PEPPER", "RUN_LOG_KEY_PEPPER", "ALERT_ENDPOINT_ENCRYPTION_KEY"]) {
    if ((values[key] || "").trim().length < 32) throw new Error(`${key} must contain at least 32 characters.`)
  }
  if (!isExactBase64Key(values.EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64, 32)) {
    throw new Error("EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64 must be canonical base64 for exactly 32 bytes.")
  }
  if (!/^[A-Za-z0-9._-]{3,64}$/.test((values.EVAL_CLEANUP_SIGNING_KEY_ID || "").trim())) {
    throw new Error("EVAL_CLEANUP_SIGNING_KEY_ID must be a stable 3-64 character identifier.")
  }
  try {
    const cleanupKey = createPrivateKey({ key: Buffer.from((values.EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 || "").trim(), "base64"), format: "der", type: "pkcs8" })
    if (cleanupKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519")
  } catch {
    throw new Error("EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 must be a base64 PKCS#8 Ed25519 private key.")
  }
  if (!isPublicHostname(values.EVAL_INBOUND_DOMAIN)) throw new Error("EVAL_INBOUND_DOMAIN must be a public DNS hostname.")
  if (!/^[^\s@]+@maintainflow\.io$/i.test((values.MAINTAINFLOW_ALERT_FROM_EMAIL || "").trim())) {
    throw new Error("MAINTAINFLOW_ALERT_FROM_EMAIL must use the verified @maintainflow.io sender.")
  }
  if (stage === "canary") {
    if ((values.BUSINESS_EVALS_FIXTURE_SIGNING_SECRET || "").trim().length < 32) {
      throw new Error("BUSINESS_EVALS_FIXTURE_SIGNING_SECRET must contain at least 32 characters for the bounded canary.")
    }
    const fixtureFromEmail = (values.BUSINESS_EVALS_FIXTURE_FROM_EMAIL || values.MAINTAINFLOW_ALERT_FROM_EMAIL || "").trim()
    if (!/^[^\s@]+@maintainflow\.io$/i.test(fixtureFromEmail)) {
      throw new Error("Controlled fixture email must use a verified @maintainflow.io sender.")
    }
  }
  validateStripeReleaseValues(values, stage)
  validateBrowserbaseEgressProxy(values)

  if (businessEvalsWorkspaceAllowlist.length) {
    console.log(`A staged Business Evals workspace allowlist is present (${businessEvalsWorkspaceAllowlist.length} workspace entries).`)
  }
}

function validateStripeReleaseValues(values, stage) {
  const expectedMode = stage === "launch" ? "live" : "test"
  if (!new RegExp(`^(?:sk|rk)_${expectedMode}_[A-Za-z0-9]+$`).test((values.STRIPE_SECRET_KEY || "").trim())) {
    throw new Error(`STRIPE_SECRET_KEY must be a Stripe ${expectedMode}-mode secret or restricted key for the ${stage} stage.`)
  }
  if (!/^whsec_[A-Za-z0-9_]+$/.test((values.STRIPE_WEBHOOK_SECRET || "").trim())) {
    throw new Error("STRIPE_WEBHOOK_SECRET must have Stripe webhook-secret structure.")
  }
  if (!/^bpc_[A-Za-z0-9]+$/.test((values.STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID || "").trim())) {
    throw new Error("STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID must have Stripe portal-configuration structure.")
  }
  const priceKeys = [
    "STRIPE_PRICE_SOLO",
    "STRIPE_PRICE_TEAM",
    "STRIPE_PRICE_AGENCY",
    "STRIPE_PRICE_SOLO_ANNUAL",
    "STRIPE_PRICE_TEAM_ANNUAL",
    "STRIPE_PRICE_AGENCY_ANNUAL",
  ]
  const priceIds = priceKeys.map((key) => (values[key] || "").trim())
  if (!priceIds.every((value) => /^price_[A-Za-z0-9]+$/.test(value))) {
    throw new Error("Every public monthly and annual Stripe price must use a Stripe price_ ID.")
  }
  if (new Set(priceIds).size !== priceIds.length) {
    throw new Error("Every public monthly and annual Stripe Price ID must be distinct.")
  }
}

function isExactBase64Key(value, expectedBytes) {
  const normalized = String(value || "").trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return false
  const decoded = Buffer.from(normalized, "base64")
  return decoded.length === expectedBytes
    && decoded.toString("base64").replace(/=+$/, "") === normalized.replace(/=+$/, "")
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
