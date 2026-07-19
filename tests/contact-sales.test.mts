import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const contactSalesPage = readFileSync("src/app/contact-sales/page.tsx", "utf8")
const contactSalesRoute = readFileSync("src/app/api/contact-sales/route.ts", "utf8")
const retiredRetryRoute = readFileSync("src/app/api/cron/retry-lead-notifications/route.ts", "utf8")
const retirementMigration = readFileSync("supabase/maintainflow_retire_paid_pilot_runtime.sql", "utf8")
const schedulerSql = readFileSync("supabase/maintainflow_scheduler.sql", "utf8")
const schedulerVerifySql = readFileSync("supabase/maintainflow_scheduler_verify.sql", "utf8")
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> }

const deletedRuntimeFiles = [
  "src/components/marketing/contact-sales-form.tsx",
  "src/lib/sales/contact-lead-notification-cron.ts",
  "src/lib/sales/contact-lead-notification-delivery.server.ts",
  "src/lib/sales/contact-lead-notification.server.ts",
  "src/lib/sales/contact-lead-notification.ts",
  "src/lib/sales/contact-leads.server.ts",
  "src/lib/sales/contact-leads.ts",
  "scripts/apply-accepted-pilot-workspace-gate.mjs",
  "scripts/capture-founder-launch.mjs",
]

test("legacy sales acquisition redirects to direct signup and cannot accept leads", () => {
  assert.match(contactSalesPage, /permanentRedirect\("\/sign-up"\)/)
  assert.match(contactSalesRoute, /status: 410/)
  assert.match(contactSalesRoute, /signupUrl: "\/sign-up"/)
  assert.match(contactSalesRoute, /Cache-Control": "no-store"/)
  assert.doesNotMatch(contactSalesRoute, /request\.json|storeContactSalesLead|notifyStoredContactSalesLead|leadId/)
})

test("retired notification cron is a no-store 410 stub for GET and POST", () => {
  assert.match(retiredRetryRoute, /status: 410/)
  assert.match(retiredRetryRoute, /Cache-Control": "no-store"/)
  assert.match(retiredRetryRoute, /export async function POST\(\)/)
  assert.match(retiredRetryRoute, /export async function GET\(\)/)
  assert.match(retiredRetryRoute, /Paid-pilot lead notifications have been retired/)
  assert.doesNotMatch(retiredRetryRoute, /CRON_SECRET|authorization|process\.env|retryPending|handleContact/)
})

test("paid-pilot application and notification runtime files are deleted", () => {
  for (const file of deletedRuntimeFiles) {
    assert.equal(existsSync(file), false, `${file} must stay retired`)
  }
  assert.equal(packageJson.scripts?.["launch:capture"], undefined)
})

test("retirement migration removes executable capabilities without mutating historical leads", () => {
  assert.match(retirementMigration, /cron\.unschedule\('maintainflow-retry-pilot-lead-notifications'\)/)
  assert.match(retirementMigration, /drop function if exists public\.claim_contact_sales_lead_notifications\(uuid, integer\)/)
  assert.match(retirementMigration, /drop function if exists public\.record_contact_sales_lead_notification_result\(uuid, text, text\)/)
  assert.match(retirementMigration, /drop function if exists public\.record_contact_sales_lead_notification_result\(uuid, integer, text, text\)/)
  assert.match(retirementMigration, /drop function if exists public\.requeue_contact_sales_lead_notification\(uuid\)/)
  assert.match(retirementMigration, /drop function if exists public\.provision_accepted_pilot_workspace\(uuid, text, text, text, citext, text, text, timestamptz\)/)
  assert.doesNotMatch(retirementMigration, /drop table|truncate|delete from|update public\.contact_sales_leads/i)
})

test("active scheduler only schedules assurance checks and verifies the pilot retry job is absent", () => {
  assert.match(schedulerSql, /cron\.schedule\(\s*'maintainflow-run-checks'/)
  assert.match(schedulerSql, /cron\.unschedule\('maintainflow-retry-pilot-lead-notifications'\)/)
  assert.doesNotMatch(schedulerSql, /\/api\/cron\/retry-lead-notifications/)
  assert.doesNotMatch(schedulerSql, /cron\.schedule\(\s*'maintainflow-retry-pilot-lead-notifications'/)
  assert.match(schedulerVerifySql, /retired_paid_pilot_retry_job_absent/)
  assert.match(schedulerVerifySql, /where jobname = 'maintainflow-retry-pilot-lead-notifications'/)
})
