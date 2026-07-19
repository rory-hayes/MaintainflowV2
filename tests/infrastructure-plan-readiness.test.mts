import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const readiness = readFileSync("scripts/local-deploy-readiness.mjs", "utf8")
const envPush = readFileSync("scripts/push-vercel-env.mjs", "utf8")
const envExample = readFileSync("ENV_EXAMPLE.md", "utf8")
const providerChecklist = readFileSync("PRODUCTION_PROVIDER_CHECKLIST.md", "utf8")

const attestations = [
  "SUPABASE_PRODUCTION_PLAN_CONFIRMED",
  "VERCEL_COMMERCIAL_PLAN_CONFIRMED",
  "BROWSERBASE_CUSTOM_PROXY_PLAN_CONFIRMED",
]

test("release helpers fail closed until production-capable provider plans are verified", () => {
  for (const key of attestations) {
    for (const source of [readiness, envPush, envExample]) assert.match(source, new RegExp(key))
  }
  assert.match(readiness, /Supabase Pro or higher/)
  assert.match(readiness, /Vercel Pro or higher/)
  assert.match(readiness, /Browserbase Developer or higher/)
  assert.match(envPush, /values\[key\] !== "true"/)
})

test("the provider checklist names the paid-plan release boundary", () => {
  assert.match(providerChecklist, /automatic backups are available and inactivity pausing is disabled/)
  assert.match(providerChecklist, /non-commercial Hobby plan/)
  assert.match(providerChecklist, /custom-proxy session is created successfully/)
})
