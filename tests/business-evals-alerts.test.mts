import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  alertEncryptionAssociatedData,
  createAlertSigningSecret,
  decryptAlertValue,
  encryptAlertValue,
} from "../src/lib/api/alerts-crypto.ts"
import {
  alertEmailMessage,
  alertTargetPreview,
  normalizeAlertEmail,
  safeAlertText,
} from "../src/lib/api/alerts-shared.ts"
import { nextWebhookAttemptAt } from "../src/lib/alerts/outbound-webhook.ts"

const encryptionSecret = "maintain-flow-alert-encryption-secret-for-focused-tests"
const associatedData = alertEncryptionAssociatedData({
  agencyId: "agency-1",
  endpointId: "endpoint-1",
  field: "target",
})

test("alert destinations use authenticated encryption bound to their workspace and endpoint", () => {
  const destination = "https://hooks.example.com/maintain-flow?channel=alerts"
  const ciphertext = encryptAlertValue(destination, encryptionSecret, associatedData)
  assert.doesNotMatch(ciphertext, /hooks\.example\.com/)
  assert.equal(decryptAlertValue(ciphertext, encryptionSecret, associatedData), destination)
  assert.throws(() => decryptAlertValue(ciphertext, encryptionSecret, associatedData.replace("agency-1", "agency-2")))
  assert.throws(() => decryptAlertValue(ciphertext, `${encryptionSecret}-different`, associatedData))
})

test("webhook signing secrets are high entropy and endpoint previews never reveal full targets", () => {
  const first = createAlertSigningSecret()
  const second = createAlertSigningSecret()
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first, second)
  assert.equal(alertTargetPreview("email", normalizeAlertEmail("Owner@Example.com")), "o***@example.com")
  assert.equal(alertTargetPreview("webhook", "https://hooks.example.com/private/token"), "https://hooks.example.com/…")
})

test("alert copy is bounded and carries only safe event fields", () => {
  assert.equal(safeAlertText("failed\u0000\n  retry", "fallback"), "failed retry")
  assert.equal(safeAlertText("x".repeat(600), "fallback").length, 500)
  const message = alertEmailMessage({
    eventId: "delivery-1",
    eventType: "eval_run.completed",
    status: "failed",
    summary: "The expected thank-you state was not observed.",
    dashboardUrl: "https://www.maintainflow.io/eval-runs/run-1",
  })
  assert.match(message.subject, /eval run — completed/i)
  assert.match(message.text, /Event ID: delivery-1/)
  assert.doesNotMatch(message.text, /credential|trace|raw email/i)
})

test("alert retries stop after the eighth delivery attempt", () => {
  for (let attempt = 1; attempt < 8; attempt += 1) {
    assert.ok(nextWebhookAttemptAt(attempt, 0))
  }
  assert.equal(nextWebhookAttemptAt(8, 0), null)
})

test("alert settings and delivery routes enforce tenant auth and cron auth boundaries", () => {
  const settingsRoute = readFileSync("src/app/api/settings/alerts/route.ts", "utf8")
  const endpointRoute = readFileSync("src/app/api/settings/alerts/[id]/route.ts", "utf8")
  const cronRoute = readFileSync("src/app/api/cron/deliver-eval-alerts/route.ts", "utf8")
  const service = readFileSync("src/lib/api/alerts.server.ts", "utf8")
  const delivery = readFileSync("src/lib/api/alerts-delivery.server.ts", "utf8")

  assert.match(settingsRoute, /requireBusinessEvalsAuth/)
  assert.match(endpointRoute, /roles: \["owner", "admin"\]/)
  assert.match(service, /ALERTS_PAID_PLAN_REQUIRED/)
  assert.match(service, /validateEndpointUrlForRequest/)
  assert.match(cronRoute, /isAuthorizedCronRequest/)
  assert.match(delivery, /attempt < 8/)
  assert.match(service, /eval_alert_outbox/)
  assert.match(service, /status: `eq\.\$\{String\(outbox\.status\)\}`/)
  assert.match(service, /attempt_count: `eq\.\$\{Number\(outbox\.attempt_count \?\? 0\)\}`/)
  assert.match(service, /contended: true/)
  assert.match(delivery, /reconcileFinalizedEvalAlertOutbox/)
  assert.match(delivery, /report_safe_summary/)
  assert.match(delivery, /idempotencyKey: event\.id/)
  assert.match(delivery, /\{ idempotencyKey: input\.idempotencyKey \}/)
  assert.doesNotMatch(delivery, /raw_email|trace_data|credentials/)
})
