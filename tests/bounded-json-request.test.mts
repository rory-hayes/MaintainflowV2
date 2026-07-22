import assert from "node:assert/strict"
import test from "node:test"

import {
  BoundedJsonRequestError,
  readBoundedJson,
  readOptionalBoundedJson,
} from "../src/lib/http/bounded-json.server.ts"

test("bounded JSON parsing verifies content type and actual bytes", async () => {
  await assert.rejects(
    () => readBoundedJson(new Request("https://example.test", { method: "POST", body: "{}" }), 16),
    (error) => error instanceof BoundedJsonRequestError && error.status === 415,
  )
  await assert.rejects(
    () => readBoundedJson(new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "too long" }),
    }), 8),
    (error) => error instanceof BoundedJsonRequestError && error.status === 413,
  )
  assert.deepEqual(await readBoundedJson(new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{\"ok\":true}",
  }), 32), { ok: true })
})

test("optional bounded JSON accepts an empty cron body but still rejects unsafe payloads", async () => {
  assert.deepEqual(await readOptionalBoundedJson(new Request("https://example.test", { method: "POST" }), 16), {})
  await assert.rejects(
    () => readOptionalBoundedJson(new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    }), 16),
    (error) => error instanceof BoundedJsonRequestError && error.status === 415,
  )
  await assert.rejects(
    () => readOptionalBoundedJson(new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "too long" }),
    }), 8),
    (error) => error instanceof BoundedJsonRequestError && error.status === 413,
  )
})
