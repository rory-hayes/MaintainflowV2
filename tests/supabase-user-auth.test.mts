import assert from "node:assert/strict"
import test from "node:test"

import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "../src/lib/supabase/user-auth.ts"

test("endpoint auth config is disabled for local auth mode", () => {
  const config = getSupabaseUserAuthConfig({
    NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE: "local",
    NEXT_PUBLIC_SUPABASE_URL: "https://maintainflow.supabase.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test_public_key_1234567890",
  })

  assert.equal(config.enabled, false)
})

test("endpoint auth config supports branded Supabase auth URL", () => {
  const config = getSupabaseUserAuthConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://maintainflow.supabase.test",
    NEXT_PUBLIC_SUPABASE_AUTH_URL: "https://auth.maintainflow.io",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test_public_key_1234567890",
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
      anonKey: "sb_publishable_test_public_key_1234567890",
    },
    (async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        authorization: headers.get("authorization") ?? "",
        apikey: headers.get("apikey") ?? "",
      })
      return String(url).endsWith("/rest/v1/rpc/current_auth_account_activation_status")
        ? Response.json([{ activation_required: false, activation_complete: true }])
        : Response.json({ id: "user_123", email: "ops@agency.com" })
    }) as typeof fetch
  )

  assert.deepEqual(user, { id: "user_123", email: "ops@agency.com" })
  assert.deepEqual(calls, [
    {
      url: "https://auth.maintainflow.io/auth/v1/user",
      authorization: "Bearer access-token",
      apikey: "sb_publishable_test_public_key_1234567890",
    },
    {
      url: "https://maintainflow.supabase.test/rest/v1/rpc/current_auth_account_activation_status",
      authorization: "Bearer access-token",
      apikey: "sb_publishable_test_public_key_1234567890",
    },
  ])
})

test("Supabase endpoint token verification rejects a pending email-signup activation", async () => {
  await assert.rejects(
    verifySupabaseAccessToken(
      "pending-token",
      {
        enabled: true,
        supabaseUrl: "https://maintainflow.supabase.test",
        authUrl: "https://maintainflow.supabase.test",
        anonKey: "sb_publishable_test_public_key_1234567890",
      },
      (async (url) => String(url).endsWith("/auth/v1/user")
        ? Response.json({ id: "pending-user", email: "pending@agency.com" })
        : Response.json([{ activation_required: true, activation_complete: false }])) as typeof fetch
    ),
    /Confirm your email/
  )
})

test("Supabase endpoint token verification rejects invalid sessions", async () => {
  await assert.rejects(
    verifySupabaseAccessToken(
      "bad-token",
      {
        enabled: true,
        supabaseUrl: "https://maintainflow.supabase.test",
        authUrl: "https://maintainflow.supabase.test",
        anonKey: "sb_publishable_test_public_key_1234567890",
      },
      (async () => Response.json({ msg: "JWT expired" }, { status: 401 })) as typeof fetch
    ),
    /JWT expired/
  )
})
