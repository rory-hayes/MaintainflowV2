import assert from "node:assert/strict"
import test from "node:test"

import { hashRateLimitKey } from "../src/lib/ops/rate-limit-events.shared.ts"

test("rate-limit keys are hashed with the configured scope and pepper", () => {
  const raw = "agency-id:user-id"
  const first = hashRateLimitKey("endpoint_test", raw, "pepper")
  const second = hashRateLimitKey("endpoint_test", raw, "pepper")
  const differentScope = hashRateLimitKey("other", raw, "pepper")

  assert.equal(first, second)
  assert.notEqual(first, raw)
  assert.notEqual(first, differentScope)
  assert.match(first, /^[a-f0-9]{64}$/)
})
