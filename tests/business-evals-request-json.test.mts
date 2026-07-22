import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"

import {
  BusinessEvalsRequestJsonError,
  parseRequestJson,
} from "../src/lib/api/business-evals-contracts.ts"

const schema = z.object({ value: z.string() }).strict()

test("business-evals JSON parsing requires JSON and enforces an actual byte ceiling", async () => {
  await assert.rejects(
    () => parseRequestJson(new Request("https://example.test", { method: "POST", body: "{}" }), schema),
    (error) => error instanceof BusinessEvalsRequestJsonError && error.status === 415,
  )
  await assert.rejects(
    () => parseRequestJson(new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(256 * 1024) }),
    }), schema),
    (error) => error instanceof BusinessEvalsRequestJsonError && error.status === 413,
  )
  assert.deepEqual(await parseRequestJson(new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "ok" }),
  }), schema), { value: "ok" })
})
