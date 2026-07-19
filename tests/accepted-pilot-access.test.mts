import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workspaceMigration = readFileSync("supabase/maintainflow_self_serve_workspace_provisioning.sql", "utf8")
const entitlementMigration = readFileSync("supabase/maintainflow_billing_entitlements_migration.sql", "utf8")
const freePlanMigration = readFileSync("supabase/maintainflow_free_plan_migration.sql", "utf8")
const retirementMigration = readFileSync("supabase/maintainflow_retire_paid_pilot_runtime.sql", "utf8")
const schema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const buildScript = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> }

const createFunctionSignature = /public\.create_agency_workspace\(text, text, text, citext\)/
const protectedBillingColumns = [
  "plan",
  "trial_ends_at",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_subscription_status",
  "complimentary_entitlement",
  "complimentary_entitlement_reason",
]

function assertOrdered(source: string, earlier: string, later: string) {
  const earlierIndex = source.indexOf(earlier)
  const laterIndex = source.indexOf(later)
  assert.notEqual(earlierIndex, -1, `Missing earlier contract: ${earlier}`)
  assert.notEqual(laterIndex, -1, `Missing later contract: ${later}`)
  assert.ok(earlierIndex < laterIndex, `Expected ${earlier} before ${later}`)
}

function grantedAgencyColumns(source: string) {
  const match = source.match(/grant update \(([^)]+)\)\s*on public\.agencies to authenticated;/)
  if (!match) assert.fail("Authenticated agency update column grant is missing.")
  return new Set(match[1].split(",").map((column) => column.trim()))
}

function assertOneWorkspaceMembershipBoundary(source: string) {
  assert.match(
    source,
    /create unique index if not exists memberships_user_id_unique_idx\s+on public\.memberships \(user_id\);/
  )
  assert.match(source, /drop policy if exists memberships_manage_admins on public\.memberships;/)
  assert.match(
    source,
    /create policy memberships_insert_admins on public\.memberships\s+for insert to authenticated\s+with check \(\(select public\.has_agency_role\(agency_id, array\['owner', 'admin'\]::public\.agency_role\[\]\)\)\);/
  )
  assert.match(
    source,
    /create policy memberships_update_admins on public\.memberships\s+for update to authenticated\s+using \(\(select public\.has_agency_role\(agency_id, array\['owner', 'admin'\]::public\.agency_role\[\]\)\)\)\s+with check \(\(select public\.has_agency_role\(agency_id, array\['owner', 'admin'\]::public\.agency_role\[\]\)\)\);/
  )
  assert.doesNotMatch(
    source,
    /create policy memberships_[a-z_]+ on public\.memberships\s+for delete to authenticated/
  )
  assert.match(source, /revoke update, delete on public\.memberships from authenticated;/)
  assert.match(source, /grant update \(role\) on public\.memberships to authenticated;/)
  assert.match(source, /grant select, insert, update, delete on public\.memberships to service_role;/)
}

test("authenticated users can create exactly one Free workspace without a call or manual pilot gate", () => {
  assert.match(workspaceMigration, /current_user_id uuid := \(select auth\.uid\(\)\)/)
  assert.match(workspaceMigration, /Authentication is required/)
  assert.match(workspaceMigration, /Agency name is required/)
  assert.match(workspaceMigration, /length\(trim\(agency_name\)\) > 120/)
  assert.match(workspaceMigration, /This account already belongs to a workspace/)
  assert.match(workspaceMigration, /insert into public\.agencies \(name, slug, report_sender_name, report_sender_email, plan\)/)
  assert.match(workspaceMigration, /values \(trim\(agency_name\), clean_slug, coalesce\(sender_name, ''\), sender_email, 'free'\)/)
  assert.match(workspaceMigration, /insert into public\.memberships \(agency_id, user_id, role\)/)
  assert.match(workspaceMigration, /values \(created_agency\.id, current_user_id, 'owner'\)/)
  assert.match(workspaceMigration, /revoke all on function public\.create_agency_workspace[^\n]+from public, anon;/)
  assert.match(workspaceMigration, /grant execute on function public\.create_agency_workspace[^\n]+to authenticated;/)
  assert.doesNotMatch(workspaceMigration, /provision_accepted_pilot_workspace/)
})

test("workspace creation serializes retries and concurrent requests before duplicate checks", () => {
  const userLock = "pg_advisory_xact_lock(hashtext('self-serve-workspace-user:' || current_user_id::text))"
  const membershipGuard = "if exists (select 1 from public.memberships where user_id = current_user_id)"
  const slugLock = "pg_advisory_xact_lock(hashtext('self-serve-workspace-slug:' || clean_slug))"
  const agencyInsert = "insert into public.agencies"

  assertOrdered(workspaceMigration, userLock, membershipGuard)
  assertOrdered(workspaceMigration, membershipGuard, slugLock)
  assertOrdered(workspaceMigration, slugLock, agencyInsert)
  assert.match(workspaceMigration, /if exists \(select 1 from public\.agencies where slug = clean_slug\)[\s\S]+gen_random_uuid/)
  assert.equal((workspaceMigration.match(/insert into public\.memberships/g) ?? []).length, 1)
  assert.match(workspaceMigration, /return created_agency/)
})

test("one-workspace membership identity cannot be deleted or reassigned by authenticated users", () => {
  assertOneWorkspaceMembershipBoundary(workspaceMigration)
  assertOneWorkspaceMembershipBoundary(schema)
})

test("fresh schema mirrors authenticated self-serve workspace creation", () => {
  assert.match(schema, createFunctionSignature)
  assert.match(schema, /current_user_id uuid := \(select auth\.uid\(\)\)/)
  assert.match(schema, /self-serve-workspace-user:/)
  assert.match(schema, /self-serve-workspace-slug:/)
  assert.match(schema, /This account already belongs to a workspace/)
  assert.match(schema, /values \(trim\(agency_name\), clean_slug, coalesce\(sender_name, ''\), sender_email, 'free'\)/)
  assert.match(schema, /grant execute on function public\.create_agency_workspace[^\n]+to authenticated;/)
})

test("production builds apply entitlement and assurance guards before retiring paid-pilot capabilities", () => {
  assert.equal(packageJson.scripts?.postbuild, "node scripts/apply-self-serve-workspace-access.mjs")
  assert.match(buildScript, /VERCEL_ENV === "production"/)
  assert.match(buildScript, /requires DATABASE_URL/)
  assert.match(buildScript, /maintainflow_free_plan_migration\.sql/)
  assert.match(buildScript, /maintainflow_billing_entitlements_migration\.sql/)
  assert.match(buildScript, /maintainflow_self_serve_workspace_provisioning\.sql/)
  assert.match(buildScript, /maintainflow_retire_paid_pilot_runtime\.sql/)
  assert.match(buildScript, /if \(!planLabelSet\.has\("free"\)\)/)
  assertOrdered(buildScript, "withoutTransactionWrapper(freePlanMigration)", "withoutTransactionWrapper(entitlementMigration)")
  assertOrdered(buildScript, "withoutTransactionWrapper(entitlementMigration)", "withoutTransactionWrapper(workspaceMigration)")
  assertOrdered(buildScript, "withoutTransactionWrapper(workspaceMigration)", "withoutTransactionWrapper(assuranceIntegrityMigration)")
  assertOrdered(buildScript, "withoutTransactionWrapper(assuranceIntegrityMigration)", "withoutTransactionWrapper(paidPilotRetirementMigration)")
  assertOrdered(buildScript, 'client.query("begin")', "withoutTransactionWrapper(freePlanMigration)")
  assertOrdered(buildScript, "const permissions = await client.query", 'client.query(isDryRun ? "rollback" : "commit")')
  assert.match(buildScript, /MIGRATION_DRY_RUN === "true"/)
  assert.match(buildScript, /dry run verified and rolled back/)
  assert.match(buildScript, /historicalContactSalesLeadCountAfter === historicalContactSalesLeadCountBefore/)
  assert.match(buildScript, /if \(transactionOpen\) await client\.query\("rollback"\)/)
  assert.match(buildScript, /function withoutTransactionWrapper/)
  assert.match(buildScript, /has_function_privilege\('authenticated', 'public\.create_agency_workspace/)
  assert.match(buildScript, /authenticated_can_create/)
  assert.match(buildScript, /paid_pilot_functions_absent/)
  assert.match(buildScript, /paid_pilot_retry_job_absent/)
  assert.match(buildScript, /historical_contact_sales_leads_preserved/)
  assert.doesNotMatch(buildScript, /service_can_provision|authenticated_can_provision/)
  assert.match(buildScript, /has_column_privilege\('authenticated', 'public\.agencies', 'plan', 'update'\)/)
  assert.match(buildScript, /has_column_privilege\('authenticated', 'public\.agencies', 'stripe_subscription_id', 'update'\)/)
  assert.match(buildScript, /has_table_privilege\('authenticated', 'public\.memberships', 'delete'\)/)
  assert.match(buildScript, /has_column_privilege\('authenticated', 'public\.memberships', 'role', 'update'\)/)
  assert.match(buildScript, /has_column_privilege\('authenticated', 'public\.memberships', 'user_id', 'update'\)/)
  assert.match(buildScript, /has_column_privilege\('authenticated', 'public\.memberships', 'agency_id', 'update'\)/)
  assert.match(buildScript, /memberships_user_id_unique_idx/)
  assert.match(buildScript, /free_plan_ready/)
  assert.match(buildScript, /one_workspace_per_user_ready/)
  assert.match(buildScript, /clients_enforce_billing_limit/)
  assert.match(buildScript, /workflows_enforce_billing_limit/)
  assert.match(buildScript, /reports_enforce_billing_limit/)
  assert.match(buildScript, /workflows_frequency_safe/)
  assert.match(buildScript, /checks_schedule_safe/)
  assert.match(buildScript, /supabase-pooler:/)
  assert.match(buildScript, /aws-0-\$\{region\}\.pooler\.supabase\.com/)
  assert.match(buildScript, /poolerUrl\.username = `postgres\.\$\{projectRef\}`/)
  assert.match(buildScript, /connectionTimeoutMillis: 5_000/)
  assert.match(buildScript, /\["ENETUNREACH", "ENOTFOUND"\]/)

  assert.match(retirementMigration, /drop function if exists public\.provision_accepted_pilot_workspace/)
  assert.doesNotMatch(retirementMigration, /drop table|truncate|delete from public\.contact_sales_leads/i)
})

test("legacy production schemas add Free in a committed migration before entitlement SQL uses it", () => {
  assert.match(freePlanMigration, /create type public\.agency_plan_next as enum \('free', 'starter', 'growth', 'scale', 'agency_plus'\)/)
  assert.match(freePlanMigration, /alter column plan type public\.agency_plan_next/)
  assert.match(freePlanMigration, /where plan = 'growth'::public\.agency_plan_next[\s\S]+stripe_customer_id is null[\s\S]+stripe_subscription_id is null/)
  assert.match(freePlanMigration, /alter type public\.agency_plan_next rename to agency_plan/)
  assert.match(buildScript, /select enumlabel[\s\S]+pg_type\.typname = 'agency_plan'/)
})

test("authenticated agency updates cannot forge billing or entitlement columns", () => {
  for (const source of [entitlementMigration, schema]) {
    assert.match(source, /revoke (?:insert, )?update(?:, delete)? on public\.agencies from authenticated;/)
    const grantedColumns = grantedAgencyColumns(source)
    assert.deepEqual(
      [...grantedColumns],
      ["name", "slug", "logo_url", "primary_color", "report_sender_name", "report_sender_email", "updated_at"]
    )
    for (const protectedColumn of protectedBillingColumns) {
      assert.equal(grantedColumns.has(protectedColumn), false, `${protectedColumn} must remain server-managed`)
    }
  }

  assert.match(schema, /stripe_subscription_status text/)
  assert.match(schema, /complimentary_entitlement boolean not null default false/)
  assert.match(schema, /complimentary_entitlement_reason text/)
  assert.match(schema, /agencies_stripe_subscription_status_valid/)
  assert.match(schema, /agencies_complimentary_entitlement_reason_required/)
})

test("database entitlements grant paid limits only for active Stripe linkage or an explicit complimentary reason", () => {
  assert.match(entitlementMigration, /when a\.complimentary_entitlement[\s\S]+a\.plan <> 'free'/)
  assert.match(entitlementMigration, /length\(trim\(coalesce\(a\.complimentary_entitlement_reason, ''\)\)\) > 0/)
  assert.match(entitlementMigration, /a\.plan not in \('free'::public\.agency_plan, 'agency_plus'::public\.agency_plan\)/)
  assert.match(entitlementMigration, /a\.stripe_customer_id is not null/)
  assert.match(entitlementMigration, /a\.stripe_subscription_id is not null/)
  assert.match(entitlementMigration, /a\.stripe_subscription_status in \('trialing', 'active'\)/)
  assert.match(entitlementMigration, /else 'free'::public\.agency_plan/)
  assert.match(entitlementMigration, /agencies_stripe_subscription_status_valid/)
  assert.match(entitlementMigration, /'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'/)
  assert.match(entitlementMigration, /agencies_complimentary_entitlement_reason_required/)
  assert.match(entitlementMigration, /revoke all on function public\.effective_agency_plan\(uuid\) from public, anon, authenticated/)
  assert.match(entitlementMigration, /revoke all on function public\.billing_plan_limit\(public\.agency_plan, text\) from public, anon, authenticated/)
})

test("database plan limits exactly match Free, Starter, Growth, and Scale product metadata", () => {
  assert.match(entitlementMigration, /when 'clients' then case target_plan\s+when 'free' then 1 when 'starter' then 5 when 'growth' then 10 when 'scale' then 30 else null end/)
  assert.match(entitlementMigration, /when 'workflows' then case target_plan\s+when 'free' then 3 when 'starter' then 50 when 'growth' then 100 when 'scale' then 300 else null end/)
  assert.match(entitlementMigration, /when 'workflows_per_client' then case target_plan\s+when 'free' then 3 when 'starter' then 10 when 'growth' then 10 when 'scale' then 10 else null end/)
  assert.match(entitlementMigration, /when 'reports_per_month' then case target_plan\s+when 'free' then 1 when 'starter' then 5 when 'growth' then 15 when 'scale' then 50 else null end/)
})

test("client, workflow, and monthly report limits are enforced by serialized database triggers", () => {
  for (const functionName of [
    "enforce_client_billing_limit",
    "enforce_workflow_billing_limit",
    "enforce_report_billing_limit",
  ]) {
    assert.match(entitlementMigration, new RegExp(`create or replace function public\\.${functionName}\\(\\)[\\s\\S]+?for update;`))
  }

  assert.match(entitlementMigration, /create trigger clients_enforce_billing_limit\s+before insert or update of agency_id, archived_at on public\.clients/)
  assert.match(entitlementMigration, /create trigger workflows_enforce_billing_limit\s+before insert or update of agency_id, client_id, archived_at on public\.workflows/)
  assert.match(entitlementMigration, /create trigger reports_enforce_billing_limit\s+before insert or update of agency_id, created_at on public\.reports/)
  assert.match(entitlementMigration, /public\.billing_plan_limit\(effective_plan, 'clients'\)/)
  assert.match(entitlementMigration, /public\.billing_plan_limit\(effective_plan, 'workflows'\)/)
  assert.match(entitlementMigration, /public\.billing_plan_limit\(effective_plan, 'workflows_per_client'\)/)
  assert.match(entitlementMigration, /public\.billing_plan_limit\(effective_plan, 'reports_per_month'\)/)
  assert.match(entitlementMigration, /date_trunc\('month', r\.created_at at time zone 'UTC'\) = date_trunc\('month', new\.created_at at time zone 'UTC'\)/)
})

test("fresh and migrated databases reject workflow or check schedules below sixty minutes", () => {
  assert.match(entitlementMigration, /update public\.workflows set frequency_minutes = 60 where frequency_minutes < 60;/)
  assert.match(entitlementMigration, /update public\.checks set schedule_minutes = 60 where schedule_minutes < 60;/)
  assert.match(entitlementMigration, /add constraint workflows_frequency_safe check \(frequency_minutes >= 60\)/)
  assert.match(entitlementMigration, /add constraint checks_schedule_safe check \(schedule_minutes >= 60\)/)

  assert.match(schema, /frequency_minutes integer not null default 60/)
  assert.match(schema, /constraint workflows_frequency_safe check \(frequency_minutes >= 60\)/)
  assert.match(schema, /schedule_minutes integer not null default 60/)
  assert.match(schema, /constraint checks_schedule_safe check \(schedule_minutes >= 60\)/)
})
