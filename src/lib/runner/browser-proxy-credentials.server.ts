import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { isIP } from "node:net"
import { domainToASCII } from "node:url"
import { TextDecoder } from "node:util"

const TOKEN_VERSION = 1 as const
const TOKEN_ISSUER = "maintainflow"
const MAX_LIFETIME_SECONDS = 15 * 60
const MAX_CLOCK_SKEW_SECONDS = 30
const MAX_SIDE_EFFECT_HOSTS = 20
const MAX_TOKEN_BYTES = 1_024
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const SAFE_AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export type BrowserProxyCredentialClaims = {
  v: typeof TOKEN_VERSION
  iss: typeof TOKEN_ISSUER
  aud: string
  sub: string
  jti: string
  iat: number
  nbf: number
  exp: number
  seh: string[]
}

export type BrowserProxyCredentials = {
  username: string
  password: string
  expiresAt: string
}

type IssueInput = {
  subject: string
  sideEffectHosts: string[]
  now?: Date
  lifetimeSeconds?: number
  env?: Partial<Record<string, string | undefined>>
}

type VerifyInput = {
  username: string
  password: string
  now?: Date
  env?: Partial<Record<string, string | undefined>>
}

export function issueBrowserProxyCredentials(input: IssueInput): BrowserProxyCredentials {
  const env = input.env ?? process.env
  const keyId = requiredSafeValue(env.BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID, SAFE_KEY_ID, "BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID")
  const audience = requiredSafeValue(env.BROWSERBASE_EGRESS_PROXY_AUDIENCE, SAFE_AUDIENCE, "BROWSERBASE_EGRESS_PROXY_AUDIENCE")
  const privateKey = readEd25519PrivateKey(env.BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64)
  const subject = requiredSafeValue(input.subject, SAFE_SUBJECT, "browser proxy credential subject")
  const lifetimeSeconds = input.lifetimeSeconds ?? MAX_LIFETIME_SECONDS
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > MAX_LIFETIME_SECONDS) {
    throw new Error(`Browser proxy credentials must live for between 60 and ${MAX_LIFETIME_SECONDS} seconds.`)
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000)
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new Error("Browser proxy credential time is invalid.")
  }
  const sideEffectHosts = normalizeSideEffectHosts(input.sideEffectHosts)
  const claims: BrowserProxyCredentialClaims = {
    v: TOKEN_VERSION,
    iss: TOKEN_ISSUER,
    aud: audience,
    sub: subject,
    jti: randomBytes(16).toString("base64url"),
    iat: nowSeconds,
    nbf: nowSeconds - MAX_CLOCK_SKEW_SECONDS,
    exp: nowSeconds + lifetimeSeconds,
    seh: sideEffectHosts,
  }
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")
  const signature = sign(null, Buffer.from(encodedClaims, "ascii"), privateKey).toString("base64url")
  const password = `${encodedClaims}.${signature}`
  if (Buffer.byteLength(password, "ascii") > MAX_TOKEN_BYTES) {
    throw new Error(`Browser proxy credentials must not exceed ${MAX_TOKEN_BYTES} bytes.`)
  }

  return {
    username: `mf1.${keyId}`,
    password,
    expiresAt: new Date(claims.exp * 1_000).toISOString(),
  }
}

export function verifyBrowserProxyCredentials(input: VerifyInput): BrowserProxyCredentialClaims {
  const env = input.env ?? process.env
  const audience = requiredSafeValue(env.BROWSERBASE_EGRESS_PROXY_AUDIENCE, SAFE_AUDIENCE, "BROWSERBASE_EGRESS_PROXY_AUDIENCE")
  const [prefix, keyId, extraUsernamePart] = input.username.split(".")
  if (prefix !== "mf1" || !keyId || extraUsernamePart || !SAFE_KEY_ID.test(keyId)) {
    throw new Error("Browser proxy credential username is invalid.")
  }
  const publicKeys = readPublicKeys(env.BROWSERBASE_EGRESS_PROXY_VERIFY_KEYS_JSON)
  const publicKey = publicKeys.get(keyId)
  if (!publicKey) throw new Error("Browser proxy credential key is not trusted.")

  if (Buffer.byteLength(input.password, "ascii") > MAX_TOKEN_BYTES || /[^A-Za-z0-9_.-]/.test(input.password)) {
    throw new Error("Browser proxy credential token is invalid.")
  }
  const [encodedClaims, encodedSignature, extraTokenPart] = input.password.split(".")
  if (!encodedClaims || !encodedSignature || extraTokenPart) {
    throw new Error("Browser proxy credential token is invalid.")
  }
  let signature: Buffer
  let claimsBytes: Buffer
  try {
    signature = decodeCanonicalBase64Url(encodedSignature)
  } catch {
    throw new Error("Browser proxy credential signature is invalid.")
  }
  try {
    claimsBytes = decodeCanonicalBase64Url(encodedClaims)
  } catch {
    throw new Error("Browser proxy credential claims are invalid.")
  }
  if (signature.length !== 64 || !verify(null, Buffer.from(encodedClaims, "ascii"), publicKey, signature)) {
    throw new Error("Browser proxy credential signature is invalid.")
  }

  let value: unknown
  try {
    const claimsText = new TextDecoder("utf-8", { fatal: true }).decode(claimsBytes)
    rejectDuplicateTopLevelJsonKeys(claimsText)
    value = JSON.parse(claimsText)
  } catch {
    throw new Error("Browser proxy credential claims are invalid.")
  }
  const claims = validateClaims(value, audience)
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000)
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new Error("Browser proxy credential time is invalid.")
  }
  if (nowSeconds < claims.nbf || nowSeconds >= claims.exp || claims.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) {
    throw new Error("Browser proxy credential has expired or is not active.")
  }
  return claims
}

export function normalizeSideEffectHosts(hosts: string[]) {
  if (!Array.isArray(hosts) || hosts.length > MAX_SIDE_EFFECT_HOSTS) {
    throw new Error(`Browser proxy credentials support at most ${MAX_SIDE_EFFECT_HOSTS} approved side-effect hosts.`)
  }
  const normalized = [...new Set(hosts.map((host) => normalizeHostname(host)))].sort()
  if (normalized.length > MAX_SIDE_EFFECT_HOSTS) {
    throw new Error(`Browser proxy credentials support at most ${MAX_SIDE_EFFECT_HOSTS} approved side-effect hosts.`)
  }
  return normalized
}

function normalizeHostname(value: string) {
  const candidate = value.trim().replace(/\.$/, "").toLowerCase()
  const ascii = domainToASCII(candidate)
  const labels = ascii.split(".")
  if (
    !ascii
    || ascii.length > 253
    || !ascii.includes(".")
    || isIP(ascii)
    || ascii === "localhost"
    || ascii.endsWith(".localhost")
    || /^\d+$/.test(labels.at(-1) ?? "")
    || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Browser proxy side-effect hosts must be valid DNS hostnames.")
  }
  return ascii
}

function decodeCanonicalBase64Url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value.")
  }
  const decoded = Buffer.from(value, "base64url")
  if (decoded.toString("base64url") !== value) {
    throw new Error("Non-canonical base64url value.")
  }
  return decoded
}

function validateClaims(value: unknown, audience: string): BrowserProxyCredentialClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser proxy credential claims are invalid.")
  const record = value as Record<string, unknown>
  const exactKeys = ["aud", "exp", "iat", "iss", "jti", "nbf", "seh", "sub", "v"]
  if (Object.keys(record).sort().join(",") !== exactKeys.join(",")) throw new Error("Browser proxy credential claims are invalid.")
  if (
    record.v !== TOKEN_VERSION
    || record.iss !== TOKEN_ISSUER
    || record.aud !== audience
    || typeof record.sub !== "string"
    || !SAFE_SUBJECT.test(record.sub)
    || typeof record.jti !== "string"
    || !/^[A-Za-z0-9_-]{22}$/.test(record.jti)
    || !Number.isSafeInteger(record.iat)
    || !Number.isSafeInteger(record.nbf)
    || !Number.isSafeInteger(record.exp)
    || (record.exp as number) - (record.iat as number) > MAX_LIFETIME_SECONDS
    || (record.exp as number) <= (record.iat as number)
    || (record.nbf as number) > (record.iat as number)
    || (record.iat as number) - (record.nbf as number) > MAX_CLOCK_SKEW_SECONDS
    || !Array.isArray(record.seh)
  ) {
    throw new Error("Browser proxy credential claims are invalid.")
  }
  const sideEffectHosts = normalizeSideEffectHosts(record.seh as string[])
  if (JSON.stringify(sideEffectHosts) !== JSON.stringify(record.seh)) {
    throw new Error("Browser proxy credential side-effect hosts are not canonical.")
  }
  return record as BrowserProxyCredentialClaims
}

function readEd25519PrivateKey(encoded: string | undefined) {
  if (!encoded?.trim()) throw new Error("BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64 is required.")
  let key: KeyObject
  try {
    key = createPrivateKey({ key: Buffer.from(encoded.trim(), "base64"), format: "der", type: "pkcs8" })
  } catch {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64 must contain a base64-encoded PKCS#8 Ed25519 private key.")
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The browser proxy signing key must use Ed25519.")
  return key
}

function readPublicKeys(encoded: string | undefined) {
  if (!encoded?.trim()) throw new Error("BROWSERBASE_EGRESS_PROXY_VERIFY_KEYS_JSON is required.")
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error("BROWSERBASE_EGRESS_PROXY_VERIFY_KEYS_JSON must be a JSON object of key IDs to base64 SPKI Ed25519 public keys.")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_VERIFY_KEYS_JSON must be a JSON object of key IDs to base64 SPKI Ed25519 public keys.")
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 || entries.length > 4) throw new Error("Browser proxy verification requires between one and four trusted keys.")
  const keys = new Map<string, KeyObject>()
  for (const [keyId, encodedKey] of entries) {
    if (!SAFE_KEY_ID.test(keyId) || typeof encodedKey !== "string" || !encodedKey) {
      throw new Error("Browser proxy verification key entries are invalid.")
    }
    let key: KeyObject
    try {
      key = createPublicKey({ key: Buffer.from(encodedKey, "base64"), format: "der", type: "spki" })
    } catch {
      throw new Error("Browser proxy verification keys must be base64-encoded SPKI Ed25519 public keys.")
    }
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Browser proxy verification keys must use Ed25519.")
    keys.set(keyId, key)
  }
  return keys
}

function requiredSafeValue(value: string | undefined, pattern: RegExp, label: string) {
  const normalized = value?.trim() ?? ""
  if (!pattern.test(normalized)) throw new Error(`${label} is missing or invalid.`)
  return normalized
}

function rejectDuplicateTopLevelJsonKeys(json: string) {
  let index = 0
  const skipWhitespace = () => {
    while (/\s/.test(json[index] ?? "")) index += 1
  }
  const readStringToken = () => {
    const start = index
    if (json[index] !== '"') throw new Error("Expected a JSON object key.")
    index += 1
    let escaped = false
    while (index < json.length) {
      const character = json[index]
      index += 1
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') return json.slice(start, index)
    }
    throw new Error("Unterminated JSON string.")
  }

  skipWhitespace()
  if (json[index] !== "{") return
  index += 1
  const keys = new Set<string>()
  while (index < json.length) {
    skipWhitespace()
    if (json[index] === "}") return
    const key = JSON.parse(readStringToken()) as string
    if (keys.has(key)) throw new Error("Duplicate JSON key.")
    keys.add(key)
    skipWhitespace()
    if (json[index] !== ":") throw new Error("Expected a JSON property separator.")
    index += 1

    let childDepth = 0
    let inString = false
    let escaped = false
    while (index < json.length) {
      const character = json[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') inString = false
      } else if (character === '"') {
        inString = true
      } else if (character === "{" || character === "[") {
        childDepth += 1
      } else if (character === "}" || character === "]") {
        if (character === "}" && childDepth === 0) return
        childDepth -= 1
      } else if (character === "," && childDepth === 0) {
        index += 1
        break
      }
      index += 1
    }
  }
}

export function browserProxyPublicKeyBase64(privateKeyBase64: string) {
  const privateKey = readEd25519PrivateKey(privateKeyBase64)
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64")
}
