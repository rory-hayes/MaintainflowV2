import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { safeAuthNextPath, safeSignInHrefForRoute } from "../src/lib/auth/next-path.ts"

test("authenticated eval routes preserve a safe path and query through sign in", () => {
  const href = safeSignInHrefForRoute(
    "/journeys/2f1276eb-84a7-4a64-a6b7-8f13ab60b14b",
    "view=evidence&stage=verification%20email"
  )

  const signInUrl = new URL(href, "https://www.maintainflow.io")
  assert.equal(signInUrl.pathname, "/sign-in")
  assert.equal(
    signInUrl.searchParams.get("next"),
    "/journeys/2f1276eb-84a7-4a64-a6b7-8f13ab60b14b?view=evidence&stage=verification%20email"
  )
})

test("auth destinations fail closed for cross-origin and malformed route candidates", () => {
  assert.equal(safeAuthNextPath("https://attacker.example/runs", "/projects"), "/projects")
  assert.equal(safeAuthNextPath("//attacker.example/runs", "/projects"), "/projects")
  assert.equal(safeAuthNextPath("/journeys\\attacker", "/projects"), "/projects")
  assert.equal(
    new URL(safeSignInHrefForRoute("//attacker.example", "next=%2Fincidents"), "https://www.maintainflow.io").searchParams.get("next"),
    "/projects"
  )
})

test("the eval boundary uses the current authenticated route instead of a fixed Projects destination", () => {
  const source = readFileSync("src/components/evals/evals-route-boundary.tsx", "utf8")

  assert.match(source, /useSearchParams\(\)/)
  assert.match(source, /safeSignInHrefForRoute\(pathname, searchParams\.toString\(\)\)/)
  assert.match(source, /<Link href=\{signInHref\}/)
  assert.doesNotMatch(source, /next=%2Fprojects/)
})
