import assert from "node:assert/strict"
import test from "node:test"

import { baseNextConfig } from "../next.config.ts"
import { buildProductionSecurityHeaders } from "../src/lib/security/headers.ts"

test("production security headers include report-only CSP and enforced browser protections", () => {
  const headers = Object.fromEntries(
    buildProductionSecurityHeaders({
      NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
      NEXT_PUBLIC_SUPABASE_AUTH_URL: "https://auth.maintainflow.io",
    }).map(({ key, value }) => [key.toLowerCase(), value])
  )

  assert.equal(headers["x-content-type-options"], "nosniff")
  assert.equal(headers["x-frame-options"], "DENY")
  assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin")
  assert.match(headers["permissions-policy"], /camera=\(\)/)
  assert.match(headers["strict-transport-security"], /max-age=/)

  const csp = headers["content-security-policy-report-only"]
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /https:\/\/project-ref\.supabase\.co/)
  assert.match(csp, /https:\/\/auth\.maintainflow\.io/)
  assert.match(csp, /https:\/\/accounts\.google\.com/)
  assert.match(csp, /https:\/\/checkout\.stripe\.com/)
})

test("Next applies the security header baseline to every route", async () => {
  assert.equal(typeof baseNextConfig.headers, "function")
  const rules = await baseNextConfig.headers?.()

  assert.equal(rules?.length, 2)
  assert.equal(rules?.[0]?.source, "/:path*")
  const names = new Set(rules?.[0]?.headers.map((header) => header.key.toLowerCase()))
  assert.equal(names.has("content-security-policy-report-only"), true)
  assert.equal(names.has("x-content-type-options"), true)
  assert.equal(names.has("x-frame-options"), true)
  assert.equal(names.has("strict-transport-security"), true)

  assert.equal(rules?.[1]?.source, "/share/reports/:path*")
  const shareHeaders = Object.fromEntries(rules?.[1]?.headers.map((header) => [header.key.toLowerCase(), header.value]) ?? [])
  assert.equal(shareHeaders["cache-control"], "private, no-store, max-age=0")
  assert.equal(shareHeaders["referrer-policy"], "no-referrer")
  assert.equal(shareHeaders["x-robots-tag"], "noindex, nofollow, noarchive")
})
