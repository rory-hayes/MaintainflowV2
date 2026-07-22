import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { redactObservabilityText, scrubSentryEvent } from "../src/lib/observability/sentry-scrub.ts"
import { safeServerLog } from "../src/lib/observability/safe-server-log.ts"

test("observability redaction removes credentials, emails, and URL query data", () => {
  const redacted = redactObservabilityText(
    "Request https://app.example.com/path?token=private failed for owner@example.com with Bearer abc.def and sk_live_secret"
  )
  assert.equal(redacted?.includes("private"), false)
  assert.equal(redacted?.includes("owner@example.com"), false)
  assert.equal(redacted?.includes("abc.def"), false)
  assert.equal(redacted?.includes("sk_live_secret"), false)
  assert.match(redacted ?? "", /https:\/\/app\.example\.com\/path/)

  const jsonRedacted = redactObservabilityText('{"password":"supersecret","token":"abc.def"}')
  assert.equal(jsonRedacted?.includes("supersecret"), false)
  assert.equal(jsonRedacted?.includes("abc.def"), false)
  const quotedMultiword = redactObservabilityText('{"password":"open sesame"}')
  assert.equal(quotedMultiword?.includes("open"), false)
  assert.equal(quotedMultiword?.includes("sesame"), false)
})

test("Sentry events retain diagnostics without user or request payload data", () => {
  const event = scrubSentryEvent({
    user: { email: "owner@example.com" },
    request: { method: "POST", url: "https://app.example.com/private?token=one", data: "secret" },
    message: "Failed for owner@example.com",
    transaction: "/journeys/private-journey-id",
    culprit: "owner@example.com",
    tags: { customer: "owner@example.com" },
    fingerprint: ["owner@example.com"],
    modules: { privateModule: "secret" },
    server_name: "private-host",
    spans: [{ data: { url: "https://app.example.com/private?token=one" } }],
    logentry: { formatted: "owner@example.com", params: ["private"] },
    extra: { payload: "private" },
    contexts: { runtime: { name: "node", version: ["sk", "live", "MFTRANSPORTCANARY123456"].join("_"), owner: "owner@example.com", canary: "SENTRY-CANARY" }, private: { token: "one" } },
    exception: { values: [{ type: ["sk", "live", "MFTRANSPORTCANARY123456"].join("_"), value: '{"password":"supersecret"}', mechanism: { data: { canary: "SENTRY-CANARY" } }, stacktrace: { custom_payload: "SENTRY-CANARY", frames: [{ filename: "https://app.example.com/private?token=one", abs_path: "https://app.example.com/private?token=one", function: "runJourney", lineno: 42, vars: { token: "private" } }] } }] },
    threads: { values: [{ stacktrace: { frames: [{ filename: "https://app.example.com/private?token=one", vars: { token: "private" } }] } }] },
    breadcrumbs: [{ message: "owner@example.com", category: "SENTRY-CANARY", data: { body: "private" } }],
  } as unknown as Parameters<typeof scrubSentryEvent>[0] & { request: { method: string; url?: string; data?: string } })

  assert.equal(event.user, undefined)
  assert.deepEqual(event.request, { method: "POST" })
  assert.equal(event.extra, undefined)
  assert.equal(event.transaction, undefined)
  assert.equal(event.tags, undefined)
  assert.equal(event.spans, undefined)
  assert.equal(event.logentry?.params, undefined)
  assert.equal(event.contexts, undefined)
  assert.equal(event.exception?.values?.[0]?.type, "ApplicationError")
  assert.equal(event.exception?.values?.[0]?.value, "Exception details withheld")
  assert.equal(event.exception?.values?.[0]?.mechanism, undefined)
  assert.equal(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars, undefined)
  assert.equal(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename, undefined)
  assert.equal(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.abs_path, undefined)
  assert.equal(event.threads?.values?.[0]?.stacktrace?.frames?.[0]?.vars, undefined)
  assert.equal(event.threads?.values?.[0]?.stacktrace?.frames?.[0]?.filename, undefined)
  assert.equal(event.breadcrumbs?.[0]?.data, undefined)
  assert.equal(event.breadcrumbs?.[0]?.category, "application")
  assert.equal(JSON.stringify(event).includes("SENTRY-CANARY"), false)
  assert.equal(JSON.stringify(event).includes("MFTRANSPORTCANARY"), false)
  assert.equal(event.message, "Application error (details withheld)")
})

test("Next.js monitoring is wired for browser, server, edge, global render errors, and source maps", () => {
  for (const file of ["instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
    const source = readFileSync(file, "utf8")
    assert.match(source, /sendDefaultPii: false/)
    assert.match(source, /tracesSampleRate: 0/)
    assert.match(source, /beforeSend: scrubSentryEvent/)
  }
  assert.match(readFileSync("instrumentation.ts", "utf8"), /captureRequestError/)
  const globalError = readFileSync("src\/app\/global-error.tsx", "utf8")
  assert.match(globalError, /captureException\(error\)/)
  assert.match(globalError, /could not confirm whether the last action completed/)
  assert.doesNotMatch(globalError, /data has not been changed/i)
  const config = readFileSync("next.config.ts", "utf8")
  assert.match(config, /withSentryConfig\(withWorkflow\(baseNextConfig\)/)
  assert.match(config, /authToken: process\.env\.SENTRY_AUTH_TOKEN/)
  assert.match(config, /sentryUrl: "https:\/\/sentry\.io"/)
  assert.match(config, /telemetry: false/)
  assert.match(config, /deleteSourcemapsAfterUpload: true/)
})

test("server logs accept only bounded identifiers and never raw errors or provider text", () => {
  const originalError = console.error
  const calls: unknown[][] = []
  console.error = (...args: unknown[]) => { calls.push(args) }
  try {
    safeServerLog("error", "business-evals-api-failure", {
      reference: "safe-reference",
      eventId: "line-break\nSENTRY-CANARY secret@example.com",
    })
  } finally {
    console.error = originalError
  }

  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(calls).includes("SENTRY-CANARY"), false)
  assert.equal(JSON.stringify(calls).includes("secret@example.com"), false)
  assert.match(JSON.stringify(calls), /safe-reference/)

  for (const file of [
    "src/lib/api/business-evals-auth.server.ts",
    "src/app/api/webhooks/resend/inbound/route.ts",
    "src/app/api/billing/webhook/route.ts",
  ]) {
    const source = readFileSync(file, "utf8")
    assert.doesNotMatch(source, /console\.(?:error|warn)\(/)
    assert.match(source, /safeServerLog/)
  }
})
