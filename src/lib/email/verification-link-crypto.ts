import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const VERSION = "v1"

type VerificationLinkScope = {
  agencyId: string
  runId: string
  eventId: string
}

export function encryptVerificationLink(
  link: string,
  encodedKey: string,
  scope: VerificationLinkScope
) {
  assertHttpsLink(link)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv)
  cipher.setAAD(Buffer.from(associatedData(scope), "utf8"))
  const ciphertext = Buffer.concat([cipher.update(link, "utf8"), cipher.final()])
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

export function decryptVerificationLink(
  encrypted: string,
  encodedKey: string,
  scope: VerificationLinkScope
) {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded, extra] = encrypted.split(".")
  if (version !== VERSION || !ivEncoded || !tagEncoded || !ciphertextEncoded || extra !== undefined) {
    throw new Error("The encrypted verification link is not in a supported format.")
  }
  const decipher = createDecipheriv("aes-256-gcm", decodeKey(encodedKey), Buffer.from(ivEncoded, "base64url"))
  decipher.setAAD(Buffer.from(associatedData(scope), "utf8"))
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8")
  assertHttpsLink(plaintext)
  return plaintext
}

export function hashVerificationLink(link: string | null) {
  return link ? createHash("sha256").update(link, "utf8").digest("hex") : null
}

export function verificationLinkAssociatedData(scope: VerificationLinkScope) {
  return associatedData(scope)
}

function decodeKey(value: string) {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64 must be valid base64.")
  }
  const key = Buffer.from(normalized, "base64")
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error("EVAL_EMAIL_LINK_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes.")
  }
  return key
}

function associatedData(scope: VerificationLinkScope) {
  return `maintain-flow:eval-email-link:${scope.agencyId}:${scope.runId}:${scope.eventId}`
}

function assertHttpsLink(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Only credential-free HTTPS verification links can be encrypted.")
  }
}
