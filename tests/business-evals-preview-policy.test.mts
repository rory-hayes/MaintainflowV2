import assert from "node:assert/strict"
import test from "node:test"

import { isBusinessEvalsPreviewRequestAllowed } from "../src/lib/features/business-evals-preview-policy.ts"

const token = "a".repeat(64)

test("development preview requires only the explicit preview flag", () => {
  assert.equal(isBusinessEvalsPreviewRequestAllowed({
    env: { NODE_ENV: "development", BUSINESS_EVALS_PREVIEW: "1" },
  }), true)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({
    env: { NODE_ENV: "development", BUSINESS_EVALS_PREVIEW: "0" },
  }), false)
})

test("production preview requires an exact random token and never opens on Vercel", () => {
  const env = {
    NODE_ENV: "production",
    BUSINESS_EVALS_PREVIEW: "1",
    BUSINESS_EVALS_E2E_PREVIEW_TOKEN: token,
  }
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env, presentedToken: token }), true)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env, presentedToken: "b".repeat(64) }), false)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env, presentedToken: "short" }), false)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env: { ...env, VERCEL: "1" }, presentedToken: token }), false)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env: { ...env, VERCEL_ENV: "production" }, presentedToken: token }), false)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env: { ...env, NEXT_PUBLIC_VERCEL_ENV: "production" }, presentedToken: token }), false)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({ env: { ...env, VERCEL: "0" }, presentedToken: token }), false)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({
    env: {
      ...env,
      BUSINESS_EVALS_LOCAL_E2E_ENV_CLEARED: "1",
      VERCEL: "0",
      VERCEL_ENV: "0",
      NEXT_PUBLIC_VERCEL_ENV: "0",
    },
    presentedToken: token,
  }), true)
  assert.equal(isBusinessEvalsPreviewRequestAllowed({
    env: { ...env, BUSINESS_EVALS_LOCAL_E2E_ENV_CLEARED: "1", VERCEL: "1" },
    presentedToken: token,
  }), false)
})
