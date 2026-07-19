import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto"

import { isSyntheticMarker } from "../evals/synthetic.ts"

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type CleanupSigningKey = {
  keyId: string
  privateKey: KeyObject
}

export type CleanupWebhookJwk = JsonWebKey & {
  alg: "EdDSA"
  kid: string
  use: "sig"
}

export type CleanupWebhookEnvelope = Readonly<{
  schemaVersion: 1
  event: "maintain_flow.eval.cleanup"
  eventId: string
  audience: string
  issuedAt: number
  runId: string
  journeyId: string
  syntheticMarker: string
}>

export function cleanupWebhookEventId(runId: string) {
  if (!UUID_PATTERN.test(runId)) throw new Error("A valid eval run identifier is required for cleanup.")
  return `cleanup:${runId.toLowerCase()}`
}

export function cleanupWebhookAudience(target: string | URL) {
  const url = new URL(target.toString())
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The cleanup webhook audience must be a credential-free HTTPS URL.")
  }
  url.hash = ""
  return `sha256:${createHash("sha256").update(url.toString(), "utf8").digest("hex")}`
}

export function createCleanupWebhookEnvelope(input: {
  runId: string
  journeyId: string
  syntheticMarker: string
  target: string | URL
  issuedAt: number
}): CleanupWebhookEnvelope {
  if (!UUID_PATTERN.test(input.journeyId)) throw new Error("A valid journey identifier is required for cleanup.")
  if (!isSyntheticMarker(input.syntheticMarker)) throw new Error("A canonical synthetic marker is required for cleanup.")
  assertCleanupTimestamp(input.issuedAt)
  return Object.freeze({
    schemaVersion: 1,
    event: "maintain_flow.eval.cleanup",
    eventId: cleanupWebhookEventId(input.runId),
    audience: cleanupWebhookAudience(input.target),
    issuedAt: input.issuedAt,
    runId: input.runId.toLowerCase(),
    journeyId: input.journeyId.toLowerCase(),
    syntheticMarker: input.syntheticMarker,
  })
}

export function loadCleanupSigningKey(
  env: Readonly<Record<string, string | undefined>> = process.env
): CleanupSigningKey {
  const keyId = (env.EVAL_CLEANUP_SIGNING_KEY_ID ?? "").trim()
  const encodedPrivateKey = (env.EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 ?? "").trim()
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("EVAL_CLEANUP_SIGNING_KEY_ID must be a stable 3-64 character key identifier.")
  }
  if (!encodedPrivateKey) throw new Error("EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 is required.")

  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(encodedPrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    })
  } catch {
    throw new Error("EVAL_CLEANUP_SIGNING_PRIVATE_KEY_BASE64 must contain a base64-encoded PKCS#8 Ed25519 private key.")
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The cleanup signing key must use Ed25519.")
  }
  return { keyId, privateKey }
}

export function cleanupWebhookSigningInput(payload: string, timestamp: number) {
  assertCleanupTimestamp(timestamp)
  return Buffer.from(`${timestamp}.${payload}`, "utf8")
}

export function signCleanupWebhook(payload: string, timestamp: number, key: CleanupSigningKey) {
  return sign(null, cleanupWebhookSigningInput(payload, timestamp), key.privateKey).toString("base64url")
}

export function cleanupWebhookJwk(key: CleanupSigningKey): CleanupWebhookJwk {
  const exported = createPublicKey(key.privateKey).export({ format: "jwk" })
  return {
    ...exported,
    alg: "EdDSA",
    kid: key.keyId,
    use: "sig",
  }
}

function assertCleanupTimestamp(timestamp: number) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("The cleanup webhook timestamp is invalid.")
}
