import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const migrationRunner = readFileSync("scripts/apply-self-serve-workspace-access.mjs", "utf8")
const supabaseRootCa = readFileSync("supabase/prod-ca-2021.crt", "utf8")

test("production migrations verify remote database certificates", () => {
  assert.doesNotMatch(migrationRunner, /rejectUnauthorized\s*:\s*false/)
  assert.match(migrationRunner, /rejectUnauthorized:\s*true/)
  assert.match(migrationRunner, /prod-ca-2021\.crt/)
  assert.match(migrationRunner, /\.pooler\.supabase\.com/)
  assert.match(migrationRunner, /\.supabase\.co/)
  assert.match(migrationRunner, /searchParams\.delete\(parameter\)/)
})

test("the bundled Supabase trust root is a complete public certificate", () => {
  assert.match(supabaseRootCa, /^-----BEGIN CERTIFICATE-----/)
  assert.match(supabaseRootCa, /-----END CERTIFICATE-----\s*$/)
  assert.ok(supabaseRootCa.length > 1_000)
})
