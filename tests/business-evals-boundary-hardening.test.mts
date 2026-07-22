import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  decryptVerificationLink,
  encryptVerificationLink,
  hashVerificationLink,
} from "../src/lib/email/verification-link-crypto.ts"

test("verification links are encrypted with workspace, run and event binding", () => {
  const key = Buffer.alloc(32, 7).toString("base64")
  const scope = {
    agencyId: "019f7576-dbaa-7a02-9787-d0f9a03b48e4",
    runId: "119f7576-dbaa-7a02-9787-d0f9a03b48e4",
    eventId: "219f7576-dbaa-7a02-9787-d0f9a03b48e4",
  }
  const link = "https://accounts.example.com/verify?token=private"
  const encrypted = encryptVerificationLink(link, key, scope)

  assert.doesNotMatch(encrypted, /accounts|private/)
  assert.equal(decryptVerificationLink(encrypted, key, scope), link)
  assert.throws(
    () => decryptVerificationLink(encrypted, key, { ...scope, eventId: "319f7576-dbaa-7a02-9787-d0f9a03b48e4" }),
    /authenticate|Unsupported state/i
  )
  assert.match(hashVerificationLink(link) ?? "", /^[a-f0-9]{64}$/)
  assert.throws(() => encryptVerificationLink("http://accounts.example.com/verify", key, scope), /HTTPS/)
})

test("inbound email persistence is service-only and never stores a plaintext verification link", () => {
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const inbound = readFileSync("src/lib/email/resend-inbound.server.ts", "utf8")
  const workflow = readFileSync("src/workflows/eval-run.ts", "utf8")

  assert.match(migration, /inbound_email_payload_no_plaintext_link/)
  assert.match(migration, /revoke all on table public\.inbound_email_events from public, anon, authenticated/)
  const memberSelectLoop = migration.match(/foreach table_name[\s\S]*?end \$\$;/)?.[0] ?? ""
  assert.doesNotMatch(memberSelectLoop, /inbound_email_events/)
  assert.doesNotMatch(memberSelectLoop, /evidence_artifacts/)
  assert.match(migration, /revoke all on table public\.evidence_artifacts from public, anon, authenticated/)
  assert.match(inbound, /verificationLinkCiphertext/)
  assert.match(inbound, /encryptVerificationLink/)
  assert.doesNotMatch(inbound, /verificationLink:\s*metadata\.verificationLink/)
  const hookResume = inbound.match(/evalEmailHook\.resume\([\s\S]*?\n\s*\}\)/)?.[0] ?? ""
  assert.doesNotMatch(hookResume, /verificationLink/)
  assert.match(workflow, /decryptVerificationLink/)
})

test("only owner or admin receives the unguessable forwarding alias", () => {
  const journeys = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  const route = readFileSync("src/app/api/journeys/[id]/forwarding-address/route.ts", "utf8")
  const genericJourney = journeys.slice(journeys.indexOf("export async function getJourney("), journeys.indexOf("export async function getJourneyForwardingAddress"))

  assert.doesNotMatch(genericJourney, /forwardingRecipient/)
  assert.match(route, /roles: \["owner", "admin"\]/)
  assert.match(route, /Cache-Control.*private, no-store/)
})

test("shared reports require service-issued eval provenance and explicitly report-safe screenshots", () => {
  const sharing = readFileSync("src/lib/api/report-sharing.server.ts", "utf8")
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")

  assert.match(sharing, /assertServiceIssuedEvalSnapshot/)
  assert.match(sharing, /eval_snapshot_idempotency_key/)
  assert.match(sharing, /embeddedFingerprint !== fingerprint/)
  assert.match(sharing, /report_safe: "eq\.true"/)
  assert.match(migration, /report_safe boolean not null default false/)
  assert.match(migration, /not report_safe or \(artifact_kind = 'screenshot' and redacted\)/)
  assert.match(migration, /and artifact\.report_safe/)
  assert.match(migration, /enforce_business_eval_report_client_mutation_boundary/)
  assert.match(migration, /reports_eval_snapshot_provenance/)
  assert.match(migration, /snapshot_json->>'evidenceFingerprint' = eval_evidence_fingerprint/)
})

test("report-safe screenshots fail closed across text, media, form and shadow-DOM channels", () => {
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(engine, /style: REPORT_SAFE_SCREENSHOT_STYLE/)
  assert.match(engine, /color: transparent !important/)
  assert.match(engine, /background-image: none !important/)
  assert.match(engine, /html img[\s\S]+html canvas[\s\S]+html iframe[\s\S]+visibility: hidden !important/)
  assert.match(engine, /input, textarea, select, option, \[contenteditable\]/)
  assert.match(engine, /const directText[\s\S]+const customElement = tag\.includes\("-"\)/)
  assert.match(engine, /if \("locator" in action && action\.locator\) masks\.push/)
  assert.match(engine, /finally \{[\s\S]+clearScreenshotRedactionTargets/)
})

test("failure traces are real private Playwright archives rather than JSON summaries", () => {
  const engine = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(engine, /context\.tracing[\s\S]+start\(\{ screenshots: true, snapshots: true, sources: false \}\)/)
  assert.match(engine, /context\.tracing\.stop\(\{ path \}\)/)
  assert.match(engine, /contentType: "application\/zip"/)
  assert.match(engine, /reportSafe: false[\s\S]+redacted: false/)
  assert.doesNotMatch(engine, /safeJsonArtifact\("trace"/)
})

test("eval incident and note guards examine every old and new eval linkage", () => {
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const issueGuard = migration.match(/create or replace function public\.enforce_eval_incident_client_mutation_boundary\(\)[\s\S]*?\n\$\$;/)?.[0] ?? ""
  const noteGuard = migration.match(/create or replace function public\.enforce_eval_incident_note_client_mutation_boundary\(\)[\s\S]*?\n\$\$;/)?.[0] ?? ""

  for (const field of ["eval_run_id", "eval_stage_run_id", "verification_eval_run_id"]) {
    assert.match(issueGuard, new RegExp(`old\\.${field}`))
    assert.match(issueGuard, new RegExp(`new\\.${field}`))
    assert.match(noteGuard, new RegExp(`issue\\.${field}`))
  }
  assert.match(noteGuard, /old\.issue_id/)
  assert.match(noteGuard, /new\.issue_id/)
  assert.match(noteGuard, /security invoker/)
  assert.match(noteGuard, /current_user/)
  assert.doesNotMatch(noteGuard, /security definer|session_user/)
})

test("legacy incident source evidence is member-immutable and every source update is revalidated", () => {
  for (const path of [
    "supabase/maintainflow_assurance_integrity_migration.sql",
    "supabase/maintainflow_business_evals_migration.sql",
    "supabase/maintainflow_schema.sql",
  ]) {
    const sql = readFileSync(path, "utf8")
    assert.match(sql, /enforce_issue_source_client_mutation_boundary/)
    assert.match(sql, /security invoker/)
    assert.match(sql, /current_user in \('authenticated', 'anon'\)/)
    assert.match(sql, /new\.check_run_id is distinct from old\.check_run_id/)
    assert.match(sql, /before update of check_run_id on public\.issues/)
  }

  for (const path of [
    "supabase/maintainflow_assurance_integrity_migration.sql",
    "supabase/maintainflow_business_evals_migration.sql",
    "supabase/maintainflow_schema.sql",
  ]) {
    const sql = readFileSync(path, "utf8")
    const trigger = sql.match(/create trigger issues_enforce_verification_truth[\s\S]*?on public\.issues/)?.[0] ?? ""
    assert.match(trigger, /check_run_id/)
  }
})

test("incident repair writes its report-safe note and state atomically with compare-and-swap", () => {
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const incidents = readFileSync("src/lib/api/incidents.server.ts", "utf8")
  const start = migration.indexOf("create or replace function public.record_business_eval_incident_repair")
  const end = migration.indexOf("create or replace function public.enforce_business_eval_report_client_mutation_boundary", start)
  const repair = migration.slice(start, end)

  assert.match(repair, /for update/)
  assert.match(repair, /saved\.updated_at is distinct from p_expected_updated_at/)
  assert.match(repair, /insert into public\.issue_notes/)
  assert.match(repair, /update public\.issues incident set/)
  assert.match(migration, /revoke all on function public\.record_business_eval_incident_repair\(uuid,uuid,uuid,timestamptz,text\) from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.record_business_eval_incident_repair\(uuid,uuid,uuid,timestamptz,text\) to service_role/)
  assert.match(incidents, /rpc\/record_business_eval_incident_repair/)
  assert.match(incidents, /p_expected_updated_at: incident\.updatedAt/)
  assert.match(incidents, /updated_at: `eq\.\$\{incident\.updatedAt\}`/)
  assert.doesNotMatch(incidents, /await supabaseServiceJson\("issue_notes"/)
})
