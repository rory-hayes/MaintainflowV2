import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  currentLegalAcceptance,
  MAINTAINFLOW_PRIVACY_VERSION,
  MAINTAINFLOW_TERMS_VERSION,
  requireCurrentLegalAcceptance,
} from "../src/lib/legal/acceptance.ts"
import {
  clearPendingOAuthLegalAcceptance,
  OAUTH_LEGAL_ACCEPTANCE_MAX_AGE_MS,
  OAUTH_LEGAL_ACCEPTANCE_PENDING_KEY,
  preparePendingOAuthLegalAcceptance,
  readPendingOAuthLegalAcceptance,
} from "../src/lib/legal/oauth-acceptance.ts"

const authCard = readFileSync("src/components/auth/auth-card.tsx", "utf8")
const authProvider = readFileSync("src/components/auth/auth-provider.tsx", "utf8")
const passwordResetCard = readFileSync("src/components/auth/password-reset-card.tsx", "utf8")
const authClient = readFileSync("src/lib/supabase/auth.ts", "utf8")
const emailActionServer = readFileSync("src/lib/supabase/email-actions.server.ts", "utf8")
const emailActionOrchestration = readFileSync("src/lib/supabase/email-action-orchestration.ts", "utf8")
const route = readFileSync("src/app/api/legal/acceptance/route.ts", "utf8")
const migration = readFileSync("supabase/maintainflow_legal_acceptances_migration.sql", "utf8")
const canonicalSchema = readFileSync("supabase/maintainflow_schema.sql", "utf8")
const migrationRunner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")

test("the current Terms and Privacy versions are exact and source-bound", () => {
  assert.equal(MAINTAINFLOW_TERMS_VERSION, "2026-07-19")
  assert.equal(MAINTAINFLOW_PRIVACY_VERSION, "2026-07-19")
  assert.deepEqual(currentLegalAcceptance("email_signup"), {
    accepted: true,
    termsVersion: "2026-07-19",
    privacyVersion: "2026-07-19",
    source: "email_signup",
  })
  assert.throws(
    () => requireCurrentLegalAcceptance(currentLegalAcceptance("oauth_callback"), "email_signup"),
    /Accept the current Terms/
  )
})

test("signup and Google OAuth require an explicit checkbox that starts false", () => {
  assert.match(authCard, /const \[legalAccepted, setLegalAccepted\] = useState\(false\)/)
  assert.match(authCard, /checked=\{legalAccepted\}/)
  assert.match(authCard, /This box is never selected for you/)
  assert.match(authCard, /if \(!legalAccepted\)[\s\S]+current Terms and acknowledge the Privacy Policy to create an account/)
  assert.match(authCard, /if \(!legalAccepted\)[\s\S]+before continuing with Google/)
  assert.match(authCard, /currentLegalAcceptance\("email_signup"\)/)
  assert.match(authCard, /currentLegalAcceptance\("oauth_callback"\)/)
  assert.match(authProvider, /requireCurrentLegalAcceptance\(input\.legalAcceptance, "email_signup"\)/)
  assert.match(authProvider, /requireCurrentLegalAcceptance\(input\.legalAcceptance, "oauth_callback"\)/)
  assert.doesNotMatch(authCard, /defaultChecked|useState\(true\)/)
})

test("email signup sends exact acceptance metadata for a cross-device database trigger", () => {
  assert.match(authClient, /maintainflow_legal_acceptance:/)
  assert.match(authClient, /terms_version: legalAcceptance\.termsVersion/)
  assert.match(authClient, /privacy_version: legalAcceptance\.privacyVersion/)
  assert.match(migration, /after insert on auth\.users/)
  assert.match(migration, /raw_user_meta_data->'maintainflow_legal_acceptance'/)
  assert.match(migration, /auth_provider = 'google'/)
  assert.match(migration, /auth_invited_at timestamptz := new\.invited_at/)
  assert.doesNotMatch(migration, /raw_user_meta_data[^\n]*invited/i)
  assert.match(migration, /raise exception 'LEGAL_ACCEPTANCE_REQUIRED'/)
  assert.doesNotMatch(migration, /insert into public\.legal_acceptances[^;]*\bselect[^;]*from auth\.users/i)
})

test("cross-device email actions preserve exact legal evidence before success", () => {
  assert.match(emailActionServer, /terms_version: `eq\.\$\{MAINTAINFLOW_TERMS_VERSION\}`/)
  assert.match(emailActionServer, /privacy_version: `eq\.\$\{MAINTAINFLOW_PRIVACY_VERSION\}`/)
  assert.match(emailActionServer, /rpc\/record_current_legal_acceptance/)
  assert.match(emailActionServer, /p_terms_version: acceptance\.termsVersion/)
  assert.match(emailActionServer, /p_privacy_version: acceptance\.privacyVersion/)
  assert.match(emailActionServer, /p_source: acceptance\.source/)
  assert.match(emailActionOrchestration, /recordRecoveryLegalAcceptance[\s\S]+updatePassword/)
  assert.match(emailActionOrchestration, /requireSignupLegalAcceptance[\s\S]+activateSignupAccount[\s\S]+confirmed: true/)
})

test("invitation activation requires explicit current acceptance before changing the password", () => {
  assert.match(passwordResetCard, /const \[legalAccepted, setLegalAccepted\] = useState\(false\)/)
  assert.match(passwordResetCard, /Required for invitation activation and password recovery/)
  assert.match(passwordResetCard, /currentLegalAcceptance\("password_reset"\)/)
  assert.match(authClient, /recordCurrentLegalAcceptance\([\s\S]+legalAcceptance[\s\S]+legal-password-reset:[\s\S]+const config = getSupabaseConfig\(\)[\s\S]+method: "PUT"/)
  assert.match(migration, /invited_user\.invited_at is not null/)
  assert.match(migration, /p_source not in \('oauth_callback', 'password_reset'\)/)
  assert.match(passwordResetCard, /useLayoutEffect\([\s\S]+captureAndScrubPasswordResetLocation\(window\.location, window\.history\)/)
  assert.match(passwordResetCard, /const securedResetLocation = resetLocation[\s\S]+completeSupabasePasswordResetFromLocation\(securedResetLocation/)
  assert.match(passwordResetCard, /disabled=\{isReset && !resetLocation\}/)
  assert.doesNotMatch(passwordResetCard, /completeSupabasePasswordResetFromLocation\(window\.location/)
})

test("OAuth uses tab-scoped expiring pending state and records only after authentication", () => {
  const browser = installSessionStorage()
  try {
    const pending = preparePendingOAuthLegalAcceptance(
      currentLegalAcceptance("oauth_callback"),
      "/projects",
      10_000
    )
    assert.match(pending.idempotencyKey, /^legal-oauth:/)
    assert.equal(browser.values.has(OAUTH_LEGAL_ACCEPTANCE_PENDING_KEY), true)
    assert.equal(readPendingOAuthLegalAcceptance("/projects", 10_001).status, "ready")
    assert.equal(readPendingOAuthLegalAcceptance("/reports", 10_001).status, "invalid")
    assert.equal(
      readPendingOAuthLegalAcceptance("/projects", 10_000 + OAUTH_LEGAL_ACCEPTANCE_MAX_AGE_MS + 1).status,
      "invalid"
    )
    clearPendingOAuthLegalAcceptance()
    assert.equal(browser.values.size, 0)
  } finally {
    browser.restore()
  }

  assert.match(authClient, /readPendingOAuthLegalAcceptance\(expectedNextPath\)/)
  assert.match(authClient, /recordCurrentLegalAcceptance\([\s\S]+pendingState\.pending\.idempotencyKey/)
  assert.match(authClient, /"Idempotency-Key": idempotencyKey/)
  assert.match(authClient, /await recordCurrentLegalAcceptance\([\s\S]+clearPendingOAuthLegalAcceptance\(\)/)
  assert.match(authClient, /async function recordCurrentLegalAcceptance[\s\S]+await requireRecordedLegalAcceptance\(response\)/)
  assert.match(authClient, /await finalizeLegalAcceptanceForAuthCallback\(session\.access_token, location\)[\s\S]+writeSupabaseSession\(session\)/)
})

test("the acceptance API is user-bound, exact-versioned, idempotent, and narrow", () => {
  assert.match(route, /verifySupabaseAccessToken\(token, config\)/)
  assert.match(route, /z\.literal\(MAINTAINFLOW_TERMS_VERSION\)/)
  assert.match(route, /z\.literal\(MAINTAINFLOW_PRIVACY_VERSION\)/)
  assert.match(route, /request\.headers\.get\("idempotency-key"\)/)
  assert.match(route, /createHash\("sha256"\)\.update\(idempotencyKey\)\.digest\("hex"\)/)
  assert.match(route, /p_user_id: user\.id/)
  assert.doesNotMatch(route, /p_user_id: input/)
  assert.match(route, /Cache-Control": "private, no-store"/)
  assert.match(route, /const rawBody = await request\.text\(\)/)
  assert.match(route, /Buffer\.byteLength\(rawBody, "utf8"\) > 4096/)
  assert.doesNotMatch(route, /safeParse\(await request\.json/)
})

test("Postgres keeps acceptance writes service-controlled and membership fail-closed", () => {
  for (const source of [migration, canonicalSchema]) {
    assert.match(source, /create table if not exists public\.legal_acceptances/)
    assert.match(source, /create table if not exists public\.auth_account_activations/)
    assert.match(source, /alter table public\.legal_acceptances enable row level security/)
    assert.match(source, /revoke all on table public\.legal_acceptances from public, anon, authenticated, service_role/)
    assert.match(source, /grant select on table public\.legal_acceptances to service_role/)
    assert.match(source, /grant execute on function public\.record_current_legal_acceptance\(uuid,text,text,text,text\)[\s\S]+to service_role/)
    assert.match(source, /on conflict on constraint legal_acceptances_user_versions_unique do nothing/)
    assert.match(source, /memberships_require_current_legal_acceptance/)
    assert.match(source, /memberships_require_email_signup_activation/)
    assert.match(source, /current_auth_account_activation_status\(\)/)
    assert.match(source, /activate_email_signup_account\(uuid\)/)
    assert.match(source, /raise exception 'CURRENT_LEGAL_ACCEPTANCE_REQUIRED'/)
  }
  assert.match(migrationRunner, /maintainflow_legal_acceptances_migration\.sql/)
  assert.match(migrationRunner, /legal_acceptance_boundary_ready/)
})

function installSessionStorage() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const values = new Map<string, string>()
  const sessionStorage = {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key: string) { return values.get(key) ?? null },
    key(index: number) { return Array.from(values.keys())[index] ?? null },
    removeItem(key: string) { values.delete(key) },
    setItem(key: string, value: string) { values.set(key, value) },
  } satisfies Storage

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage },
  })

  return {
    values,
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    },
  }
}
