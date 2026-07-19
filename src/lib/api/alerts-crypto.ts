import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const ENCRYPTED_VALUE_VERSION = "v1"

export function deriveAlertEncryptionKey(secret: string) {
  const normalized = secret.trim()
  if (normalized.length < 32) {
    throw new Error("Alert endpoint encryption requires a secret containing at least 32 characters.")
  }
  return createHash("sha256").update(normalized, "utf8").digest()
}

export function encryptAlertValue(value: string, secret: string, associatedData: string) {
  if (!value) throw new Error("An alert value is required before it can be encrypted.")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", deriveAlertEncryptionKey(secret), iv)
  cipher.setAAD(Buffer.from(associatedData, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    ENCRYPTED_VALUE_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

export function decryptAlertValue(value: string, secret: string, associatedData: string) {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded, extra] = value.split(".")
  if (
    version !== ENCRYPTED_VALUE_VERSION
    || !ivEncoded
    || !tagEncoded
    || !ciphertextEncoded
    || extra !== undefined
  ) {
    throw new Error("The encrypted alert value is not in a supported format.")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveAlertEncryptionKey(secret),
    Buffer.from(ivEncoded, "base64url")
  )
  decipher.setAAD(Buffer.from(associatedData, "utf8"))
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ])
  return plaintext.toString("utf8")
}

export function createAlertSigningSecret() {
  return randomBytes(32).toString("base64url")
}

export function alertEncryptionAssociatedData(input: {
  agencyId: string
  endpointId: string
  field: "target" | "signing-secret"
}) {
  return `maintain-flow:alert-endpoint:${input.agencyId}:${input.endpointId}:${input.field}`
}
