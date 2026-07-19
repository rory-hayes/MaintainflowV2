import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"

import { controlledFixtureScenario, type ControlledFixtureScenario } from "@/lib/evals/controlled-fixtures"

type FixtureTokenPayload = {
  scenario: ControlledFixtureScenario
  marker: string
  expiresAt: number
}

export function createControlledFixtureToken(input: {
  scenario: ControlledFixtureScenario
  marker: string
  now?: number
}) {
  const payload: FixtureTokenPayload = {
    scenario: input.scenario,
    marker: input.marker,
    expiresAt: (input.now ?? Date.now()) + 15 * 60 * 1_000,
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${encoded}.${fixtureSignature(encoded)}`
}

export function verifyControlledFixtureToken(token: string, now = Date.now()): FixtureTokenPayload | null {
  const [encoded, receivedSignature, extra] = token.split(".")
  if (!encoded || !receivedSignature || extra) return null
  const expectedSignature = fixtureSignature(encoded)
  const received = Buffer.from(receivedSignature, "utf8")
  const expected = Buffer.from(expectedSignature, "utf8")
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<FixtureTokenPayload>
    const scenario = controlledFixtureScenario(payload.scenario)
    if (!scenario || typeof payload.marker !== "string" || !/^MF-EVAL-[A-Z0-9-]{8,120}$/.test(payload.marker)) return null
    if (!Number.isSafeInteger(payload.expiresAt) || Number(payload.expiresAt) <= now) return null
    return { scenario, marker: payload.marker, expiresAt: Number(payload.expiresAt) }
  } catch {
    return null
  }
}

function fixtureSignature(value: string) {
  return createHmac("sha256", fixtureSigningSecret()).update(value).digest("base64url")
}

function fixtureSigningSecret() {
  const configured = process.env.BUSINESS_EVALS_FIXTURE_SIGNING_SECRET?.trim() ?? ""
  if (configured.length >= 32) return configured
  if (process.env.NODE_ENV !== "production") return "maintain-flow-local-controlled-fixture-signing-only"
  throw new Error("BUSINESS_EVALS_FIXTURE_SIGNING_SECRET must contain at least 32 characters in production.")
}
