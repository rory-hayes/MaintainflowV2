import assert from "node:assert/strict"
import test from "node:test"

import { validateDeliverableEmail } from "../src/lib/auth/email.ts"
import { toActionableAuthError } from "../src/lib/auth/errors.ts"
import { isEmailPasswordAuthEnabled } from "../src/lib/supabase/config.ts"

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

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}
