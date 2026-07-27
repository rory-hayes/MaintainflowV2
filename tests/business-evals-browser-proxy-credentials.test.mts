import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  issueBrowserProxyCredentials,
  normalizeSideEffectHosts,
  verifyBrowserProxyCredentials,
} from "../src/lib/runner/browser-proxy-credentials.server.ts"

const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const privateKeyBase64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64")
const issueEnv = {
  BROWSERBASE_EGRESS_PROXY_SIGNING_KEY_ID: "primary_2026",
  BROWSERBASE_EGRESS_PROXY_AUDIENCE: "maintainflow-browser-egress",
  BROWSERBASE_EGRESS_PROXY_SIGNING_PRIVATE_KEY_BASE64: privateKeyBase64,
}
const verifyEnv = {
  BROWSERBASE_EGRESS_PROXY_AUDIENCE: "maintainflow-browser-egress",
  BROWSERBASE_EGRESS_PROXY_VERIFY_KEYS_JSON: JSON.stringify({ primary_2026: publicKeyBase64 }),
}
const now = new Date("2026-07-20T00:00:00.000Z")

test("browser proxy credentials are short-lived, signed, canonical, and scoped to approved side-effect hosts", () => {
  const credentials = issueBrowserProxyCredentials({
    subject: "workspace_123:run_456",
    sideEffectHosts: ["Forms.Example.COM.", "xn--bcher-kva.example", "forms.example.com"],
    now,
    env: issueEnv,
  })

  assert.equal(credentials.username, ["mf1", "primary_2026"].join("."))
  assert.equal(credentials.expiresAt, "2026-07-20T00:15:00.000Z")
  assert.ok(Buffer.byteLength(credentials.password, "ascii") <= 1_024)
  const claims = verifyBrowserProxyCredentials({ ...credentials, now, env: verifyEnv })
  assert.equal(claims.aud, "maintainflow-browser-egress")
  assert.equal(claims.sub, "workspace_123:run_456")
  assert.deepEqual(claims.seh, ["forms.example.com", "xn--bcher-kva.example"])
})

test("browser proxy credentials reject tampering, expiry, wrong audience, and unknown key IDs", () => {
  const credentials = issueBrowserProxyCredentials({
    subject: "workspace_123:run_456",
    sideEffectHosts: ["forms.example.com"],
    now,
    lifetimeSeconds: 60,
    env: issueEnv,
  })
  const [claims, signature] = credentials.password.split(".")

  assert.throws(
    () => verifyBrowserProxyCredentials({ ...credentials, password: `${claims.slice(0, -1)}A.${signature}`, now, env: verifyEnv }),
    /signature/
  )
  assert.throws(
    () => verifyBrowserProxyCredentials({ ...credentials, now: new Date("2026-07-20T00:01:00.000Z"), env: verifyEnv }),
    /expired/
  )
  assert.throws(
    () => verifyBrowserProxyCredentials({ ...credentials, now, env: { ...verifyEnv, BROWSERBASE_EGRESS_PROXY_AUDIENCE: "another-service" } }),
    /claims/
  )
  assert.throws(
    () => verifyBrowserProxyCredentials({ ...credentials, username: "mf1.retired", now, env: verifyEnv }),
    /not trusted/
  )
  assert.throws(
    () => verifyBrowserProxyCredentials({ ...credentials, now: new Date("invalid"), env: verifyEnv }),
    /time is invalid/
  )

  const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const finalSignatureIndex = base64UrlAlphabet.indexOf(signature.at(-1)!)
  const alternateFinalCharacter = base64UrlAlphabet[
    (finalSignatureIndex & 0b111100) | ((finalSignatureIndex + 1) & 0b11)
  ]
  const nonCanonicalSignature = `${signature.slice(0, -1)}${alternateFinalCharacter}`
  assert.ok(Buffer.from(signature, "base64url").equals(Buffer.from(nonCanonicalSignature, "base64url")))
  assert.throws(
    () => verifyBrowserProxyCredentials({
      ...credentials,
      password: `${claims}.${nonCanonicalSignature}`,
      now,
      env: verifyEnv,
    }),
    /signature is invalid/
  )
})

test("browser proxy credentials reject signed claims with duplicate top-level keys", () => {
  const nowSeconds = Math.floor(now.getTime() / 1_000)
  const claimsJson = `{"v":1,"iss":"maintainflow","aud":"maintainflow-browser-egress","aud":"maintainflow-browser-egress","sub":"run:00000000-0000-4000-8000-000000000001","jti":"abcdefghijklmnopqrstuv","iat":${nowSeconds},"nbf":${nowSeconds - 30},"exp":${nowSeconds + 60},"seh":["forms.example.com"]}`
  const encodedClaims = Buffer.from(claimsJson, "utf8").toString("base64url")
  const signature = sign(null, Buffer.from(encodedClaims, "ascii"), privateKey).toString("base64url")

  assert.throws(
    () => verifyBrowserProxyCredentials({
      username: "mf1.primary_2026",
      password: `${encodedClaims}.${signature}`,
      now,
      env: verifyEnv,
    }),
    /claims are invalid/
  )
})

test("side-effect host scope rejects IPs, URLs, wildcards, single-label names, and oversized host sets", () => {
  for (const value of ["127.0.0.1", "https://forms.example.com", "*.example.com", "localhost", "service.localhost", "example.123", "bad..example.com"]) {
    assert.throws(() => normalizeSideEffectHosts([value]), /DNS hostnames/)
  }
  assert.deepEqual(normalizeSideEffectHosts([]), [])
  assert.throws(
    () => normalizeSideEffectHosts(Array.from({ length: 21 }, (_, index) => `host-${index}.example.com`)),
    /at most 20/
  )
})

test("read-only scan credentials carry an empty side-effect allowlist", () => {
  const credentials = issueBrowserProxyCredentials({
    subject: "scan_123",
    sideEffectHosts: [],
    now,
    env: issueEnv,
  })
  const claims = verifyBrowserProxyCredentials({ ...credentials, now, env: verifyEnv })
  assert.deepEqual(claims.seh, [])
})

test("the published twenty-domain authorization ceiling fits the proxy credential envelope for ordinary hostnames", () => {
  const sideEffectHosts = Array.from({ length: 20 }, (_, index) => `action-${index}.example.com`)
  const credentials = issueBrowserProxyCredentials({
    subject: "run:00000000-0000-4000-8000-000000000001",
    sideEffectHosts,
    now,
    env: issueEnv,
  })
  assert.ok(Buffer.byteLength(credentials.password, "ascii") <= 1_024)
  assert.deepEqual(
    verifyBrowserProxyCredentials({ ...credentials, now, env: verifyEnv }).seh,
    sideEffectHosts.sort()
  )
})

test("issuer configuration rejects weak key shapes and overlong lifetimes", () => {
  assert.throws(
    () => issueBrowserProxyCredentials({ subject: "workspace:run", sideEffectHosts: ["forms.example.com"], now, env: {} }),
    /SIGNING_KEY_ID/
  )
  assert.throws(
    () => issueBrowserProxyCredentials({ subject: "workspace:run", sideEffectHosts: ["forms.example.com"], now, lifetimeSeconds: 901, env: issueEnv }),
    /between 60 and 900/
  )
  assert.throws(
    () => issueBrowserProxyCredentials({ subject: "workspace/run", sideEffectHosts: ["forms.example.com"], now, env: issueEnv }),
    /subject/
  )
})

test("the shared v1 contract fixture verifies in the app implementation", () => {
  const fixture = JSON.parse(readFileSync(
    "infra/browser-egress-proxy/interceptor/testdata/proxy-credential-v1.json",
    "utf8"
  )) as {
    audience: string
    keyId: string
    publicKeySpkiBase64: string
    username: string
    password: string
    now: number
    claims: { sub: string; exp: number; seh: string[] }
  }
  const claims = verifyBrowserProxyCredentials({
    username: fixture.username,
    password: fixture.password,
    now: new Date(fixture.now * 1_000),
    env: {
      BROWSERBASE_EGRESS_PROXY_AUDIENCE: fixture.audience,
      BROWSERBASE_EGRESS_PROXY_VERIFY_KEYS_JSON: JSON.stringify({
        [fixture.keyId]: fixture.publicKeySpkiBase64,
      }),
    },
  })
  assert.equal(claims.sub, fixture.claims.sub)
  assert.equal(claims.exp, fixture.claims.exp)
  assert.deepEqual(claims.seh, fixture.claims.seh)
})
