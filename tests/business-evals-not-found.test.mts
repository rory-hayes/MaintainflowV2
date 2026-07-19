import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("unknown public routes receive a branded recovery path", () => {
  const source = readFileSync("src/app/not-found.tsx", "utf8")

  assert.match(source, /Page not found\./)
  assert.match(source, /href="\/"/)
  assert.match(source, /href="\/login"/)
  assert.match(source, /focus-visible:ring-2/)
})
