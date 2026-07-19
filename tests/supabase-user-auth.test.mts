import assert from "node:assert/strict"
import test from "node:test"

import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "../src/lib/supabase/user-auth.ts"

test("endpoint auth config is disabled for local auth mode", () => {
  const config = getSupabaseUserAuthConfig({
    NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE: "local",
    NEXT_PUBLIC_SUPABASE_URL: "https://maintainflow.supabase.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
  })

  assert.equal(config.enabled, false)
})

test("endpoint auth config supports branded Supabase auth URL", () => {
  const config = getSupabaseUserAuthConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://maintainflow.supabase.test",
    NEXT_PUBLIC_SUPABASE_AUTH_URL: "https://auth.maintainflow.io",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
  })

  assert.equal(config.enabled, true)
  assert.equal(config.authUrl, "https://auth.maintainflow.io")
})

test("Supabase endpoint token verification returns the authenticated user", async () => {
  const calls: Array<{ url: string; authorization: string; apikey: string }> = []
  const user = await verifySupabaseAccessToken(
    "access-token",
    {
      enabled: true,
      supabaseUrl: "https://maintainflow.supabase.test",
      authUrl: "https://auth.maintainflow.io",
      anonKey: "anon-test-key",
    },
    (async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        authorization: headers.get("authorization") ?? "",
        apikey: headers.get("apikey") ?? "",
      })
      return Response.json({ id: "user_123", email: "ops@agency.com" })
    }) as typeof fetch
  )

  assert.deepEqual(user, { id: "user_123", email: "ops@agency.com" })
  assert.deepEqual(calls, [
    {
      url: "https://auth.maintainflow.io/auth/v1/user",
      authorization: "Bearer access-token",
      apikey: "anon-test-key",
    },
  ])
})

test("Supabase endpoint token verification rejects invalid sessions", async () => {
  await assert.rejects(
    verifySupabaseAccessToken(
      "bad-token",
      {
        enabled: true,
        supabaseUrl: "https://maintainflow.supabase.test",
        authUrl: "https://maintainflow.supabase.test",
        anonKey: "anon-test-key",
      },
      (async () => Response.json({ msg: "JWT expired" }, { status: 401 })) as typeof fetch
    ),
    /JWT expired/
  )
})
