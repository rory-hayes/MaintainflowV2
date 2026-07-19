import assert from "node:assert/strict"
import test from "node:test"

import { evaluateSupabaseAuthReadiness } from "../scripts/lib/auth-readiness.mjs"
import { AUTH_PASSWORD_MIN_LENGTH } from "../src/lib/auth/signup-validation.ts"

const completeAuthConfiguration = {
  NEXT_PUBLIC_SITE_URL: "https://www.maintainflow.io",
  NEXT_PUBLIC_APP_URL: "https://www.maintainflow.io",
  SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED: "true",
  SUPABASE_AUTH_SMTP_CONFIRMED: "true",
  SUPABASE_AUTH_SMTP_SENDER: "auth@maintainflow.io",
  SUPABASE_AUTH_REDIRECTS_CONFIRMED: "true",
  SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED: "true",
  SUPABASE_AUTH_PASSWORD_MIN_LENGTH: String(AUTH_PASSWORD_MIN_LENGTH),
}

test("deploy auth readiness passes only with branded SMTP, templates, redirects, Google OAuth, and matching policy", () => {
  const results = evaluateSupabaseAuthReadiness(completeAuthConfiguration)

  assert.equal(results.some((result) => result.level === "BLOCK"), false)
  assert.match(results.map((result) => result.message).join("\n"), /verified Maintain Flow SMTP sender/i)
  assert.match(results.map((result) => result.message).join("\n"), /password minimum matches/i)
})

test("deploy auth readiness blocks unverified provider branding", () => {
  const results = evaluateSupabaseAuthReadiness({
    ...completeAuthConfiguration,
    SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED: "false",
    SUPABASE_AUTH_SMTP_CONFIRMED: "",
    SUPABASE_AUTH_SMTP_SENDER: "noreply@supabase.io",
    SUPABASE_AUTH_REDIRECTS_CONFIRMED: "false",
    SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED: "false",
  })
  const blockers = results.filter((result) => result.level === "BLOCK")

  assert.equal(blockers.length, 5)
  assert.match(blockers.map((result) => result.message).join("\n"), /templates/i)
  assert.match(blockers.map((result) => result.message).join("\n"), /SMTP/i)
  assert.match(blockers.map((result) => result.message).join("\n"), /redirect/i)
  assert.match(blockers.map((result) => result.message).join("\n"), /Google OAuth/i)
  assert.match(blockers.map((result) => result.message).join("\n"), /@maintainflow\.io/i)
})

test("deploy auth readiness rejects a non-canonical production redirect origin", () => {
  const results = evaluateSupabaseAuthReadiness({
    ...completeAuthConfiguration,
    NEXT_PUBLIC_SITE_URL: "https://maintainflow.io",
  })

  assert.equal(results.some((result) => result.level === "BLOCK" && /NEXT_PUBLIC_SITE_URL/.test(result.message)), true)
})
