import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
const schema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const cancelRoute = readFileSync("src/app/api/eval-runs/[id]/route.ts", "utf8")
const cancelService = readFileSync("src/lib/api/eval-runs.server.ts", "utf8")
const shareRoute = readFileSync("src/app/api/reports/[id]/share-links/route.ts", "utf8")
const shareService = readFileSync("src/lib/api/report-sharing.server.ts", "utf8")
const adapters = readFileSync("src/components/evals/api-adapters.ts", "utf8")
const reportsPage = readFileSync("src/components/evals/pages/reports-pages.tsx", "utf8")

function functionBody(source: string, name: string) {
  return source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0] ?? ""
}

test("eval-run cancellation requires a stable key and stores only its tenant-scoped hash", () => {
  assert.match(cancelRoute, /requireIdempotencyKey\(request\)/)
  assert.match(cancelService, /eval-run-cancellation:\$\{idempotencyKey\}/)
  assert.match(cancelService, /createHash\("sha256"\)/)
  assert.match(cancelService, /p_idempotency_key_hash: idempotencyKeyHash/)
  assert.match(cancelService, /p_request_hash: requestHash/)
  assert.match(cancelService, /EVAL_RUN_CANCELLATION_IDEMPOTENCY_KEY_REUSED/)
  assert.doesNotMatch(migration, /cancel_idempotency_key(?!_hash)/)
})

test("cancellation replay is resolved before terminal-state rejection and is audit-bound", () => {
  const rpc = functionBody(migration, "request_business_eval_cancellation")
  assert.ok(rpc, "Cancellation RPC is missing.")
  assert.match(rpc, /cancel_idempotency_key_hash = p_idempotency_key_hash/)
  assert.match(rpc, /cancel_request_hash <> p_request_hash/)
  assert.match(rpc, /cancel_requested_by_user_id <> p_requested_by_user_id/)
  assert.match(rpc, /business_eval_cancellation_requested/)
  assert.ok(
    rpc.indexOf("cancel_idempotency_key_hash = p_idempotency_key_hash") < rpc.indexOf("saved_run.status not in"),
    "A same-key replay must be returned before the now-terminal run is rejected.",
  )
  assert.match(migration, /eval_runs_cancel_idempotency_uidx/)
  assert.match(migration, /request_business_eval_cancellation\(uuid,uuid,uuid,text,text\)/)
})

test("report-share revocation is an atomic, replay-safe RPC with reused-key conflict", () => {
  assert.match(shareRoute, /requireIdempotencyKey\(request\)/)
  assert.match(shareRoute, /z\.object\(\{ linkId: z\.string\(\)\.uuid\(\) \}\)\.strict\(\)/)
  assert.match(shareService, /rpc\/revoke_report_share_link_idempotent/)
  assert.match(shareService, /report-share-revocation:\$\{input\.idempotencyKey\}/)
  assert.match(shareService, /REPORT_SHARE_REVOCATION_IDEMPOTENCY_KEY_REUSED/)

  const rpc = functionBody(migration, "revoke_report_share_link_idempotent")
  assert.ok(rpc, "Report-share revocation RPC is missing.")
  assert.match(rpc, /revocation_idempotency_key_hash = p_idempotency_key_hash/)
  assert.match(rpc, /revocation_request_hash <> p_request_hash/)
  assert.match(rpc, /revoked_by_user_id <> p_requested_by_user_id/)
  assert.match(rpc, /report_share_link_revoked/)
  assert.ok(
    rpc.indexOf("revocation_idempotency_key_hash = p_idempotency_key_hash") < rpc.indexOf("saved_link.revoked_at is not null"),
    "A same-key replay must be returned before already-revoked state is rejected.",
  )
  assert.match(migration, /report_share_links_revocation_idempotency_uidx/)
  assert.match(migration, /revoke_report_share_link_idempotent\(uuid,uuid,uuid,uuid,text,text\)/)
})

test("browser callers preserve destructive-mutation keys until a response succeeds", () => {
  assert.match(adapters, /retryScope = `eval-cancel:\$\{workspaceId\}:\$\{id\}`/)
  assert.match(adapters, /idempotencyKey = pendingIdempotencyKey\(retryScope\)/)
  assert.match(adapters, /clearPendingIdempotencyKey\(retryScope, idempotencyKey\)/)
  assert.match(adapters, /window\.sessionStorage\.setItem/)
  assert.match(reportsPage, /retryScope = `share-revoke:\$\{workspaceId\}:\$\{reportIdForShare\}:\$\{linkId\}`/)
  assert.match(reportsPage, /idempotencyKey,/)
  assert.match(reportsPage, /clearPendingIdempotencyKey\(retryScope, idempotencyKey\)/)
})

test("canonical and additive schemas keep the mutation-idempotency contract identical", () => {
  for (const source of [migration, schema]) {
    assert.match(source, /cancel_idempotency_key_hash text/)
    assert.match(source, /cancel_request_hash text/)
    assert.match(source, /revocation_idempotency_key_hash text/)
    assert.match(source, /revocation_request_hash text/)
    assert.match(source, /create or replace function public\.request_business_eval_cancellation/)
    assert.match(source, /create or replace function public\.revoke_report_share_link_idempotent/)
  }
  assert.equal(
    functionBody(schema, "request_business_eval_cancellation"),
    functionBody(migration, "request_business_eval_cancellation"),
  )
  assert.equal(
    functionBody(schema, "revoke_report_share_link_idempotent"),
    functionBody(migration, "revoke_report_share_link_idempotent"),
  )
})
