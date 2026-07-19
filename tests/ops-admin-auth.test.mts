import assert from "node:assert/strict"
import test from "node:test"

import { authorizeOpsRequest, getOpsAdminEmails } from "../src/lib/ops/admin-auth.server.ts"
import { getOpsRouteKey, isOpsRouteKey } from "../src/lib/ops/route-key.ts"

test("ops route key defaults locally and supports a configured private key", () => {
  assert.equal(getOpsRouteKey({}), "mf-command-center")
  assert.equal(isOpsRouteKey("mf-command-center", {}), true)
  assert.equal(isOpsRouteKey("wrong", { MAINTAINFLOW_OPS_ROUTE_KEY: "private-key" }), false)
  assert.equal(isOpsRouteKey("private-key", { MAINTAINFLOW_OPS_ROUTE_KEY: "/private-key/" }), true)
})

test("ops admin email allowlist is normalized", () => {
  assert.deepEqual([...getOpsAdminEmails({ OPS_ADMIN_EMAILS: " Alex@Example.com, ops@example.com " })], [
    "alex@example.com",
    "ops@example.com",
  ])
})

test("ops admin auth fails closed without an allowlist", async () => {
  const result = await authorizeOpsRequest("Bearer token", {
    env: { OPS_ADMIN_EMAILS: "" },
  })

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    message: "OPS_ADMIN_EMAILS is not configured.",
  })
})

test("ops admin auth accepts a signed in allowlisted Supabase user", async () => {
  withSupabaseEnv()
  const result = await authorizeOpsRequest("Bearer access-token", {
    env: { OPS_ADMIN_EMAILS: "alex@example.com" },
    fetchImpl: (async (url, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(String(url), "https://maintainflow.supabase.test/auth/v1/user")
      assert.equal(headers.get("authorization"), "Bearer access-token")
      assert.equal(headers.get("apikey"), "anon-test-key")
      return Response.json({ id: "00000000-0000-4000-8000-000000000001", email: "alex@example.com" })
    }) as typeof fetch,
  })

  assert.deepEqual(result, {
    ok: true,
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "alex@example.com",
    },
  })
})

test("ops admin auth rejects signed in users outside the allowlist", async () => {
  withSupabaseEnv()
  const result = await authorizeOpsRequest("Bearer access-token", {
    env: { OPS_ADMIN_EMAILS: "alex@example.com" },
    fetchImpl: (async () => Response.json({ id: "user-2", email: "member@example.com" })) as typeof fetch,
  })

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    message: "This user is not allowed to open the ops console.",
  })
})

function withSupabaseEnv() {
  process.env.NEXT_PUBLIC_MAINTAINFLOW_AUTH_MODE = ""
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://maintainflow.supabase.test"
  process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL = ""
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key"
}
