import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  AUTH_PASSWORD_MIN_LENGTH,
  firstInvalidSignupField,
  validateSignupInput,
} from "../src/lib/auth/signup-validation.ts"

test("signup validation returns field-correct errors for every required input", () => {
  const result = validateSignupInput({ name: "", company: "", role: "", email: "not-an-email", password: "short" })

  assert.equal(result.ok, false)
  if (result.ok) return

  assert.deepEqual(Object.keys(result.errors), ["name", "company", "role", "email", "password"])
  assert.match(result.errors.name ?? "", /name/i)
  assert.match(result.errors.company ?? "", /company|team/i)
  assert.match(result.errors.role ?? "", /role/i)
  assert.match(result.errors.email ?? "", /valid email/i)
  assert.match(result.errors.password ?? "", new RegExp(String(AUTH_PASSWORD_MIN_LENGTH)))
  assert.equal(firstInvalidSignupField(result.errors), "name")
})

test("signup validation does not mark unrelated fields invalid", () => {
  const result = validateSignupInput({
    name: "QA Operator",
    company: "Northstar Automation",
    role: "Automation Engineer",
    email: "qa@example.com",
    password: "strong-password",
  })

  assert.equal(result.ok, false)
  if (result.ok) return

  assert.deepEqual(Object.keys(result.errors), ["email"])
  assert.equal(firstInvalidSignupField(result.errors), "email")
})

test("signup validation normalizes identity fields while preserving the submitted password", () => {
  const result = validateSignupInput({
    name: "  QA Operator  ",
    company: "  Northstar Automation ",
    role: " Automation Engineer ",
    email: " QA@Agency.co ",
    password: " six-plus-with-spaces ",
  })

  assert.equal(result.ok, true)
  if (!result.ok) return

  assert.deepEqual(result.value, {
    name: "QA Operator",
    company: "Northstar Automation",
    role: "Automation Engineer",
    email: "qa@agency.co",
    password: " six-plus-with-spaces ",
  })
})

test("signup component renders per-field errors, a form alert, and first-invalid focus wiring", () => {
  const source = readFileSync(new URL("../src/components/auth/auth-card.tsx", import.meta.url), "utf8")

  for (const field of ["name", "company", "role", "email", "password"]) {
    assert.match(source, new RegExp(`fieldErrors\\.${field}`))
    assert.match(source, new RegExp(`signup-${field}-error`))
  }

  assert.match(source, /focusSignupField\(firstInvalidSignupField\(validation\.errors\)\)/)
  assert.match(source, /role="alert"/)
  assert.match(source, /role="status"/)
  assert.match(source, /noValidate/)
  assert.doesNotMatch(source, /aria-invalid=\{!!error\}/)
})
