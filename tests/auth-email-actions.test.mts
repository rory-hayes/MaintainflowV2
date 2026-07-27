import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { currentLegalAcceptance } from "../src/lib/legal/acceptance.ts"
import {
  completeEmailActionWithDependencies,
  EmailActionRevocationError,
  type VerifiedEmailActionSession,
} from "../src/lib/supabase/email-action-orchestration.ts"
import {
  EMAIL_ACTION_MAX_BODY_BYTES,
  EmailActionRequestError,
  parseEmailActionRequest,
} from "../src/lib/supabase/email-action-request.ts"

const routeSource = readFileSync("src/app/api/auth/email-action/route.ts", "utf8")
const serverSource = readFileSync("src/lib/supabase/email-actions.server.ts", "utf8")
const confirmPageSource = readFileSync("src/app/auth/confirm/page.tsx", "utf8")

test("email-action requests require exact same-origin browser JSON", async () => {
  const validBody = JSON.stringify({ type: "email", tokenHash: "valid-token-hash-1234567890" })

  await assert.rejects(
    parseEmailActionRequest(fakeRequest(validBody, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" })),
    (error: unknown) => error instanceof EmailActionRequestError && error.status === 403,
  )
  await assert.rejects(
    parseEmailActionRequest(fakeRequest(validBody, { origin: "" })),
    (error: unknown) => error instanceof EmailActionRequestError && error.status === 403,
  )
  await assert.rejects(
    parseEmailActionRequest(fakeRequest(validBody, { origin: "https://www.maintainflow.io", "sec-fetch-site": "same-origin", "content-type": "text/plain" })),
    (error: unknown) => error instanceof EmailActionRequestError && error.status === 415,
  )

  assert.deepEqual(
    await parseEmailActionRequest(fakeRequest(validBody)),
    { type: "email", tokenHash: "valid-token-hash-1234567890" },
  )
})

test("email-action requests enforce declared and actual body caps before provider work", async () => {
  let bodyRead = false
  await assert.rejects(
    parseEmailActionRequest({
      headers: new Headers({
        origin: "https://www.maintainflow.io",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "content-length": String(EMAIL_ACTION_MAX_BODY_BYTES + 1),
      }),
      nextUrl: { origin: "https://www.maintainflow.io" },
      async text() {
        bodyRead = true
        return "{}"
      },
    }),
    (error: unknown) => error instanceof EmailActionRequestError && error.status === 413,
  )
  assert.equal(bodyRead, false)

  await assert.rejects(
    parseEmailActionRequest(fakeRequest("x".repeat(EMAIL_ACTION_MAX_BODY_BYTES + 1))),
    (error: unknown) => error instanceof EmailActionRequestError && error.status === 413,
  )
})

test("email-action schema binds token format, action type, password, and exact legal versions", async () => {
  for (const body of [
    { type: "email", tokenHash: "short" },
    { type: "email", tokenHash: "valid-token-hash-1234567890", password: "unexpected" },
    { type: "signup", tokenHash: "valid-token-hash-1234567890" },
    {
      type: "recovery",
      tokenHash: "valid-token-hash-1234567890",
      password: "secure-password",
      legalAcceptance: { ...currentLegalAcceptance("password_reset"), termsVersion: "stale" },
    },
  ]) {
    await assert.rejects(
      parseEmailActionRequest(fakeRequest(JSON.stringify(body))),
      (error: unknown) => error instanceof EmailActionRequestError && error.status === 400,
    )
  }

  assert.deepEqual(
    await parseEmailActionRequest(fakeRequest(JSON.stringify({
      type: "recovery",
      tokenHash: "valid-token-hash-1234567890",
      password: "secure-password",
      legalAcceptance: currentLegalAcceptance("password_reset"),
    }))),
    {
      type: "recovery",
      tokenHash: "valid-token-hash-1234567890",
      password: "secure-password",
      legalAcceptance: currentLegalAcceptance("password_reset"),
    },
  )
})

test("confirmation checks legal evidence and revokes before returning a token-free result", async () => {
  const calls: string[] = []
  const result = await completeEmailActionWithDependencies(
    { type: "email", tokenHash: "valid-token-hash-1234567890" },
    dependencies(calls),
  )

  assert.deepEqual(calls, [
    "verify:email",
    "signup-legal:user-1",
    "signup-activation:user-1",
    "revoke:temporary-access-token",
  ])
  assert.deepEqual(result, { confirmed: true })
  assert.doesNotMatch(JSON.stringify(result), /token|session|email|user/i)
})

test("recovery records exact legal evidence before password mutation and always revokes", async () => {
  const calls: string[] = []
  const result = await completeEmailActionWithDependencies(
    {
      type: "recovery",
      tokenHash: "valid-token-hash-1234567890",
      password: "secure-password",
      legalAcceptance: currentLegalAcceptance("password_reset"),
    },
    dependencies(calls),
  )

  assert.deepEqual(calls, [
    "verify:recovery",
    "recovery-legal:user-1",
    "password:user-1",
    "revoke:temporary-access-token",
  ])
  assert.deepEqual(result, { passwordUpdated: true })
  assert.doesNotMatch(JSON.stringify(result), /token|session|email|user/i)
})

test("post-verification failures revoke and prevent later password mutation", async () => {
  const calls: string[] = []
  const expected = new Error("legal unavailable")
  const base = dependencies(calls)

  await assert.rejects(
    completeEmailActionWithDependencies(
      {
        type: "recovery",
        tokenHash: "valid-token-hash-1234567890",
        password: "secure-password",
        legalAcceptance: currentLegalAcceptance("password_reset"),
      },
      {
        ...base,
        async recordRecoveryLegalAcceptance() {
          calls.push("recovery-legal:user-1")
          throw expected
        },
      },
    ),
    expected,
  )

  assert.deepEqual(calls, ["verify:recovery", "recovery-legal:user-1", "revoke:temporary-access-token"])
})

test("a revoke failure never reports a successful email action", async () => {
  const calls: string[] = []
  const base = dependencies(calls)

  await assert.rejects(
    completeEmailActionWithDependencies(
      { type: "email", tokenHash: "valid-token-hash-1234567890" },
      {
        ...base,
        async revoke() {
          calls.push("revoke:failed")
          throw new Error("provider unavailable")
        },
      },
    ),
    (error: unknown) => error instanceof EmailActionRevocationError && error.actionType === "email",
  )
  assert.deepEqual(calls, ["verify:email", "signup-legal:user-1", "signup-activation:user-1", "revoke:failed"])
})

test("the route is bounded and token-hash verification never exposes a temporary session", () => {
  assert.match(routeSource, /createFixedWindowRateLimiter\(\{ limit: 30/)
  assert.match(routeSource, /createFixedWindowRateLimiter\(\{ limit: 300/)
  assert.match(routeSource, /parseEmailActionRequest\(request\)/)
  assert.match(routeSource, /Cache-Control": "private, no-store, max-age=0"/)
  assert.doesNotMatch(routeSource, /access_token|refresh_token|set-cookie/i)

  assert.match(serverSource, /\/auth\/v1\/verify/)
  assert.match(serverSource, /JSON\.stringify\(\{ type, token_hash: tokenHash \}\)/)
  assert.match(serverSource, /legal_acceptances\?\$\{params\.toString\(\)\}/)
  assert.match(serverSource, /rpc\/record_current_legal_acceptance/)
  assert.match(serverSource, /rpc\/activate_email_signup_account/)
  assert.match(serverSource, /\/auth\/v1\/logout\?scope=global/)
})

test("confirmation waits for a deliberate click after capture and scrub", () => {
  assert.match(confirmPageSource, /useLayoutEffect\([\s\S]+captureAndScrubEmailConfirmationLocation\(window\.location, window\.history\)/)
  assert.match(confirmPageSource, /onClick=\{confirmEmail\}/)
  assert.match(confirmPageSource, /state === "ready"/)
  assert.doesNotMatch(confirmPageSource, /useEffect\([\s\S]+completeSupabaseEmailConfirmationFromLocation/)
})

function dependencies(calls: string[]) {
  const session: VerifiedEmailActionSession = { accessToken: "temporary-access-token", userId: "user-1" }
  return {
    async verify(type: "email" | "recovery") {
      calls.push(`verify:${type}`)
      return session
    },
    async requireSignupLegalAcceptance(userId: string) {
      calls.push(`signup-legal:${userId}`)
    },
    async activateSignupAccount(userId: string) {
      calls.push(`signup-activation:${userId}`)
    },
    async recordRecoveryLegalAcceptance(userId: string) {
      calls.push(`recovery-legal:${userId}`)
    },
    async updatePassword(verified: VerifiedEmailActionSession) {
      calls.push(`password:${verified.userId}`)
    },
    async revoke(accessToken: string) {
      calls.push(`revoke:${accessToken}`)
    },
  }
}

function fakeRequest(body: string, headers: Record<string, string> = {}) {
  return {
    headers: new Headers({
      origin: "https://www.maintainflow.io",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    }),
    nextUrl: { origin: "https://www.maintainflow.io" },
    async text() {
      return body
    },
  }
}
