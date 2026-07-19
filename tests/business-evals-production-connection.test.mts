import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const readiness = readFileSync("scripts/local-deploy-readiness.mjs", "utf8")
const envPush = readFileSync("scripts/push-vercel-env.mjs", "utf8")
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
const envExample = readFileSync("ENV_EXAMPLE.md", "utf8")
const providerChecklist = readFileSync("PRODUCTION_PROVIDER_CHECKLIST.md", "utf8")
const runbook = readFileSync("docs/business-evals/PRODUCTION_CONNECTION_RUNBOOK.md", "utf8")
const stripeBilling = readFileSync("STRIPE_BILLING.md", "utf8")
const vercelDashboard = readFileSync("VERCEL_DASHBOARD_ENV.md", "utf8")
const deploymentRunbook = readFileSync("DEPLOYMENT_RUNBOOK.md", "utf8")
const documentationIndex = readFileSync("INDEX.md", "utf8")
const features = readFileSync("src/lib/features/business-evals.ts", "utf8")

test("production release gates require every provider used by the canonical Business Evals offer", () => {
  for (const source of [readiness, envPush]) {
    for (const key of [
      "BROWSERBASE_API_KEY",
      "BROWSERBASE_EGRESS_PROXY_SERVER",
      "RESEND_INBOUND_WEBHOOK_SECRET",
      "EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64",
      "EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64",
      "REPORT_SHARE_TOKEN_PEPPER",
      "RUN_LOG_KEY_PEPPER",
      "ALERT_ENDPOINT_ENCRYPTION_KEY",
      "STRIPE_PRICE_SOLO_ANNUAL",
      "STRIPE_PRICE_TEAM_ANNUAL",
      "STRIPE_PRICE_AGENCY_ANNUAL",
    ]) assert.match(source, new RegExp(key))
  }
  assert.doesNotMatch(readiness, /providers are not complete[\s\S]+add\("WARN"/)
  assert.match(readiness, /NEXT_PUBLIC_BUSINESS_EVALS_UI must be true for the production release/)
  assert.match(readiness, /BUSINESS_EVALS_FIXTURES_ENABLED/)
  assert.match(envPush, /validateProductionReleaseValues\(env, releaseStage\)/)
  assert.match(envPush, /evaluateSupabaseAuthReadiness/)
  for (const source of [readiness, envPush, envExample, vercelDashboard]) {
    assert.match(source, /SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED/)
  }
  assert.doesNotMatch(envPush, /"GOOGLE_CLIENT_SECRET"/)
})

test("canary and launch have separate fail-closed checks and pushes", () => {
  assert.equal(packageJson.scripts["deploy:check:canary"], "node scripts/local-deploy-readiness.mjs --stage=canary")
  assert.match(packageJson.scripts["vercel:env:check:canary"], /--stage canary --dry-run/)
  assert.match(packageJson.scripts["vercel:env:push:canary"], /--stage canary/)
  assert.match(readiness, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST must contain at least one canary workspace/)
  assert.match(readiness, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST must be empty for the global release/)
  assert.match(readiness, /BUSINESS_EVALS_FIXTURES_ENABLED must be true for the bounded canary/)
  assert.match(readiness, /BUSINESS_EVALS_FIXTURES_ENABLED must be false at launch/)
  assert.match(readiness, /BUSINESS_EVALS_FIXTURE_SIGNING_SECRET/)
  assert.match(envPush, /NEXT_PUBLIC_BUSINESS_EVALS_UI must remain false during the selected-workspace canary/)
  assert.match(envPush, /BUSINESS_EVALS_WORKSPACE_ALLOWLIST must be empty for the global release/)
  assert.match(envPush, /BUSINESS_EVALS_FIXTURES_ENABLED must be true for the bounded canary/)
  assert.match(envPush, /BUSINESS_EVALS_FIXTURE_SIGNING_SECRET/)
  assert.match(envPush, /requiredKeys\.push\("BUSINESS_EVALS_WORKSPACE_ALLOWLIST", "BUSINESS_EVALS_FIXTURE_SIGNING_SECRET"\)/)
  assert.match(runbook, /Deploy to the production Vercel project without moving public DNS/)
  assert.match(runbook, /Only then point `www\.maintainflow\.io`/)
})

test("release helpers preserve annual legacy reconciliation and validate the public Stripe matrix", () => {
  for (const source of [readiness, envPush]) {
    for (const key of [
      "STRIPE_LEGACY_PRICE_STARTER_ANNUAL",
      "STRIPE_LEGACY_PRICE_GROWTH_ANNUAL",
      "STRIPE_LEGACY_PRICE_SCALE_ANNUAL",
    ]) assert.match(source, new RegExp(key))
    assert.match(source, /Every public monthly and annual Stripe Price ID (?:is|must be) distinct/)
    assert.match(source, /Stripe \$\{expectedMode\}-mode secret or restricted key|STRIPE_SECRET_KEY must be a Stripe \$\{expectedMode\}-mode secret or restricted key/)
  }
  assert.match(readiness, /CRON_SECRET contains at least 32 characters/)
  assert.match(envPush, /CRON_SECRET must contain at least 32 characters/)
})

test("operator docs describe the Business Evals plans and environment separation truthfully", () => {
  for (const value of ["€49/month", "€149/month", "€399/month", "€529.20/year", "€1,609.20/year", "€4,309.20/year"]) {
    assert.match(stripeBilling, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
  assert.match(stripeBilling, /one card-free 14-day Team trial/i)
  assert.match(stripeBilling, /Checkout does not create or restart a trial/)
  assert.doesNotMatch(stripeBilling, /upgrade to Starter, Growth, or Scale/)
  assert.doesNotMatch(stripeBilling, /Stripe-managed trial/)
  assert.match(vercelDashboard, /Add the reviewed keys to \*\*Production only\*\*/)
  assert.match(vercelDashboard, /Preview and Development must use separate test projects/)
  assert.doesNotMatch(vercelDashboard, /Add each key to:[\s\S]{0,120}- Production[\s\S]{0,120}- Preview[\s\S]{0,120}- Development/)
  assert.match(deploymentRunbook, /pnpm deploy:check:canary/)
  assert.match(deploymentRunbook, /Stripe test-mode canary/)
  assert.match(deploymentRunbook, /six distinct Price IDs/)
  assert.match(deploymentRunbook, /Only then point `www\.maintainflow\.io`/)
  assert.doesNotMatch(deploymentRunbook, /300-workflow Scale workspace|Optional provider variables|https:\/\/maintainflow\.io\/auth\/callback/)
  assert.match(documentationIndex, /PRICING_AND_ENTITLEMENTS\.md` — locked plans/)
  assert.match(documentationIndex, /former private `rory-hayes\/maintainflow` repository remains the historical record/)
  assert.match(documentationIndex, /deliberately excluded from the public V2 source snapshot/)
  assert.match(documentationIndex, /Retired SQL under `supabase\/archive\/` is also excluded from V2/)
  assert.doesNotMatch(documentationIndex, /docs\/outreach\/CURRENT-OFFER\.md/)
})

test("the retired marketing flag cannot silently restore the old public product", () => {
  for (const source of [features, envExample, providerChecklist]) {
    assert.doesNotMatch(source, /BUSINESS_EVALS_MARKETING_ENABLED/)
  }
})
