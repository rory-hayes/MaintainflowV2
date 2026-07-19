import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const sql = readFileSync(new URL("../supabase/maintainflow_public_acquisition_events.sql", import.meta.url), "utf8")

test("public acquisition table has database-level event, route, and placement boundaries", () => {
  const tableDefinition = sql.match(/create table if not exists public\.public_acquisition_events \(([\s\S]*?)\n\);/)?.[1] ?? ""

  assert.match(sql, /create table if not exists public\.public_acquisition_events/)
  assert.match(sql, /public_acquisition_event_name_check/)
  assert.match(sql, /public_acquisition_route_check/)
  assert.match(sql, /public_acquisition_event_placement_check/)
  assert.match(sql, /public_acquisition_route_placement_check/)
  assert.match(sql, /drop constraint if exists public_acquisition_event_placement_check/)
  assert.match(sql, /add constraint public_acquisition_event_placement_check/)
  assert.match(sql, /event_name in \('public_page_view', 'signup_cta_clicked'\)/)
  assert.match(sql, /event_name = 'signup_cta_clicked'\s+and placement is not null/)
  assert.match(sql, /set event_name = 'signup_cta_clicked'\s+where event_name = 'pilot_cta_clicked'/)
  assert.match(sql, /'\/sign-up'/)
  assert.doesNotMatch(tableDefinition, /session_id|user_id|agency_id|metadata_json|referrer|user_agent/)
})

test("public acquisition rows are service-role only and expire after 90 days", () => {
  assert.match(sql, /alter table public\.public_acquisition_events enable row level security/)
  assert.match(sql, /revoke all on public\.public_acquisition_events from public, anon, authenticated/)
  assert.match(sql, /create or replace function public\.prune_public_acquisition_events/)
  assert.match(sql, /created_at < now\(\) - interval '90 days'/)
  assert.match(sql, /create extension if not exists pg_cron/)
  assert.match(sql, /maintainflow-prune-public-acquisition/)
  assert.doesNotMatch(sql, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/)
})

test("public acquisition inserts have a durable global quota across serverless instances", () => {
  assert.match(sql, /create or replace function public\.record_public_acquisition_event/)
  assert.match(sql, /pg_try_advisory_xact_lock/)
  assert.doesNotMatch(sql, /perform pg_advisory_xact_lock/)
  assert.match(sql, /recent_count >= 500 or daily_count >= 5000/)
  assert.match(sql, /grant execute on function public\.record_public_acquisition_event\(text, text, text\) to service_role/)
  assert.match(sql, /insert into public\.public_acquisition_events \(event_name, route, placement\)/)
})

test("public acquisition reporting uses a service-role aggregate instead of a capped row sample", () => {
  assert.match(sql, /create or replace function public\.get_public_acquisition_metrics/)
  assert.match(sql, /count\(\*\)::bigint as event_count/)
  assert.match(sql, /grant execute on function public\.get_public_acquisition_metrics\(timestamptz\) to service_role/)
})
