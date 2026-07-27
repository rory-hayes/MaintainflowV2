import assert from "node:assert/strict"
import test from "node:test"

import {
  isSupabasePublicApiKey,
  isSupabaseServiceApiKey,
  supabaseServiceAuthHeaders,
} from "../src/lib/supabase/api-key-roles.ts"
import { getSupabaseConfig } from "../src/lib/supabase/config.ts"
import {
  supabaseServiceHeaders,
  validateProductionSupabaseConnection,
} from "../scripts/lib/supabase-release-policy.mjs"
import { validateCredentialBearingAppOrigin } from "../scripts/lib/credential-target-policy.mjs"

const projectRef = "abcdefghij1234567890"
const publicKey = "sb_publishable_test_public_key_1234567890"
const serviceKey = "sb_secret_test_server_key_1234567890"

test("production Supabase config pins the approved project and Auth origins", () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_PROJECT_REF: projectRef,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
  }

  assert.equal(getSupabaseConfig(base, "production").enabled, true)
  assert.equal(getSupabaseConfig({
    ...base,
    NEXT_PUBLIC_SUPABASE_AUTH_URL: "https://auth.maintainflow.io",
  }, "production").enabled, true)
  assert.equal(getSupabaseConfig({
    ...base,
    NEXT_PUBLIC_SUPABASE_URL: "https://credential-capture.example",
  }, "production").enabled, false)
  assert.equal(getSupabaseConfig({
    ...base,
    NEXT_PUBLIC_SUPABASE_AUTH_URL: "https://credential-capture.example",
  }, "production").enabled, false)
  assert.equal(getSupabaseConfig({ ...base, NEXT_PUBLIC_SUPABASE_PROJECT_REF: "wrongprojectref12345" }, "production").enabled, false)
})

test("browser and server Supabase key roles cannot be swapped", () => {
  assert.equal(isSupabasePublicApiKey(publicKey), true)
  assert.equal(isSupabasePublicApiKey(serviceKey), false)
  assert.equal(isSupabaseServiceApiKey(serviceKey), true)
  assert.equal(isSupabaseServiceApiKey(publicKey), false)
  assert.deepEqual(supabaseServiceAuthHeaders(serviceKey), { apikey: serviceKey })
  assert.deepEqual(supabaseServiceHeaders(serviceKey), { apikey: serviceKey })
})

test("production release policy requires modern, distinct Supabase keys", () => {
  const valid = {
    NEXT_PUBLIC_SUPABASE_URL: `https://${projectRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_PROJECT_REF: projectRef,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  }

  assert.equal(validateProductionSupabaseConnection(valid).projectOrigin, `https://${projectRef}.supabase.co`)
  assert.throws(
    () => validateProductionSupabaseConnection({
      ...valid,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: serviceKey,
      SUPABASE_SERVICE_ROLE_KEY: publicKey,
    }),
    /publishable/
  )
  assert.throws(
    () => validateProductionSupabaseConnection({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "https://other.example" }),
    /exactly match/
  )
})

test("credential-bearing release requests can target only exact Maintain Flow origins", () => {
  assert.equal(
    validateCredentialBearingAppOrigin("https://maintainflow-v2.vercel.app/"),
    "https://maintainflow-v2.vercel.app",
  )
  assert.equal(
    validateCredentialBearingAppOrigin("https://www.maintainflow.io"),
    "https://www.maintainflow.io",
  )
  assert.equal(
    validateCredentialBearingAppOrigin("http://localhost:3000", { allowLocal: true }),
    "http://localhost:3000",
  )

  for (const unsafe of [
    "https://credential-capture.example",
    "https://www.maintainflow.io.evil.example",
    "https://www.maintainflow.io/path",
    `https://${"user"}:${"password"}@www.maintainflow.io`,
    "http://www.maintainflow.io",
    "http://localhost:3001",
  ]) {
    assert.throws(() => validateCredentialBearingAppOrigin(unsafe), /exact approved root origin/)
  }
})
