import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const sql = readFileSync(new URL("../supabase/maintainflow_ops_observability.sql", import.meta.url), "utf8")

test("ops observability SQL creates durable analytics and rate-limit tables", () => {
  assert.match(sql, /create table if not exists public\.product_events/)
  assert.match(sql, /create table if not exists public\.rate_limit_events/)
  assert.match(sql, /product_events_agency_created_idx/)
  assert.match(sql, /rate_limit_events_blocked_created_idx/)
})

test("ops observability SQL uses RLS and keeps rate-limit rows service-role only", () => {
  assert.match(sql, /alter table public\.product_events enable row level security/)
  assert.match(sql, /alter table public\.rate_limit_events enable row level security/)
  assert.match(sql, /create policy product_events_members_insert/)
  assert.match(sql, /revoke all on public\.rate_limit_events from anon, authenticated/)
})

test("ops observability SQL documents sensitive data exclusions", () => {
  assert.match(sql, /raw endpoint URLs/)
  assert.match(sql, /key_hash text not null/)
})
