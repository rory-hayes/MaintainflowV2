import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { validateDeliverableEmail } from "../src/lib/auth/email.ts"
import { toActionableAuthError } from "../src/lib/auth/errors.ts"
import { getSupabaseConfig, isEmailPasswordAuthEnabled } from "../src/lib/supabase/config.ts"

const authEmailTemplates = readFileSync("supabase/auth-email-templates.md", "utf8")

test("signup email validation accepts real-looking deliverable addresses", () => {
  assert.deepEqual(validateDeliverableEmail(" Ops@Agency.co "), { ok: true, email: "ops@agency.co" })
})

test("signup email validation rejects test and placeholder domains", () => {
  for (const email of ["demo@maintainflow.test", "user@example.com", "user@localhost", "user@test.com"]) {
    const result = validateDeliverableEmail(email)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /real deliverable email|valid email/)
    }
  }
})

test("Supabase auth errors are translated into actionable signup messages", () => {
  assert.match(toActionableAuthError("User already registered"), /already exists/)
  assert.match(toActionableAuthError("over email send rate limit"), /Wait a few minutes/)
  assert.match(toActionableAuthError("signup disabled"), /Email signup is not enabled/)
})

test("hosted confirmation and recovery templates use cross-device token-hash fragments", () => {
  assert.match(authEmailTemplates, /\{\{ \.RedirectTo \}\}#token_hash=\{\{ \.TokenHash \}\}&amp;type=email/)
  assert.match(authEmailTemplates, /\{\{ \.RedirectTo \}\}#token_hash=\{\{ \.TokenHash \}\}&amp;type=recovery/)
  assert.match(authEmailTemplates, /another current browser or device/)
  assert.match(authEmailTemplates, /Disable click tracking and link rewriting/)
  assert.match(authEmailTemplates, /waits for a deliberate click/)
  assert.doesNotMatch(authEmailTemplates, /href="\{\{ \.ConfirmationURL \}\}"/)
  assert.doesNotMatch(authEmailTemplates, /signup requests PKCE|recovery has its own PKCE/i)
})

test("email/password auth stays enabled even if a stale public disable flag exists", () => {
  const previousMode = process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE
  const previousFlag = process.env.NEXT_PUBLIC_EMAIL_PASSWORD_AUTH_ENABLED

  try {
    delete process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE
    delete process.env.NEXT_PUBLIC_EMAIL_PASSWORD_AUTH_ENABLED
    assert.equal(isEmailPasswordAuthEnabled(), true)

    process.env.NEXT_PUBLIC_EMAIL_PASSWORD_AUTH_ENABLED = "false"
    assert.equal(isEmailPasswordAuthEnabled(), true)

    process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE = "local"
    process.env.NEXT_PUBLIC_EMAIL_PASSWORD_AUTH_ENABLED = "false"
    assert.equal(isEmailPasswordAuthEnabled(), true)
  } finally {
    restoreEnv("NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE", previousMode)
    restoreEnv("NEXT_PUBLIC_EMAIL_PASSWORD_AUTH_ENABLED", previousFlag)
  }
})

test("production authentication never falls back to local demo users", () => {
  const configured = {
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij1234567890.supabase.co",
    NEXT_PUBLIC_SUPABASE_PROJECT_REF: "abcdefghij1234567890",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test_public_key_1234567890",
  }
  assert.deepEqual(
    getSupabaseConfig(configured, "production").enabled,
    true
  )

  const retiredLocalMode = getSupabaseConfig({
    ...configured,
    NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE: "local",
  }, "production")
  assert.equal(retiredLocalMode.enabled, false)
  assert.equal(retiredLocalMode.localEnabled, false)

  const missingProvider = getSupabaseConfig({}, "production")
  assert.equal(missingProvider.enabled, false)
  assert.equal(missingProvider.localEnabled, false)
  assert.equal(getSupabaseConfig({}, "development").localEnabled, true)

  assert.equal(getSupabaseConfig({
    ...configured,
    NEXT_PUBLIC_SUPABASE_URL: "https://credential-capture.example",
  }, "production").enabled, false)
  assert.equal(getSupabaseConfig({
    ...configured,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_test_server_key_1234567890",
  }, "production").enabled, false)
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}
