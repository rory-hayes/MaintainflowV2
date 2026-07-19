import { createHmac } from "node:crypto"

export function signAlertWebhook(payload: string, secret: string, timestamp: number) {
  if (secret.trim().length < 32) throw new Error("Outbound webhook secrets must contain at least 32 characters.")
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")
}

export function nextWebhookAttemptAt(attempt: number, nowMs = Date.now()) {
  if (attempt < 1 || attempt >= 8) return null
  const delayMinutes = Math.min(12 * 60, 2 ** (attempt - 1))
  return new Date(nowMs + delayMinutes * 60_000).toISOString()
}
