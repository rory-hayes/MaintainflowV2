import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { evaluateAssertions, isSafeRegexPattern } from "../src/lib/core/assertions.ts"

test("all regex assertions fail closed without compiling user patterns", () => {
  const patterns = [
    "^(a+)+$",
    "^(?:(a|aa))+$",
    "^a*a*a*a*a*a*a*a*a*a*b$",
    "(?:foo){2}",
    "a".repeat(501),
  ]

  patterns.forEach((pattern, index) => {
    const [result] = evaluateAssertions(
      [{ id: `regex-${index}`, type: "regex_match", pattern, enabled: true }],
      { responseText: "a".repeat(128_000) + "!", statusCode: 200, latencyMs: 10 }
    )
    assert.equal(isSafeRegexPattern(pattern), false)
    assert.equal(result.passed, false)
    assert.match(result.reason ?? "", /disabled.*non-backtracking/i)
  })

  const source = readFileSync("src/lib/core/assertions.ts", "utf8")
  assert.doesNotMatch(source, /new\s+RegExp|RegExp\s*\(/)
})
