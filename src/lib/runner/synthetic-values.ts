import { createHash } from "node:crypto"

import { createEvalRecipient } from "../email/eval-inbound.ts"
import { isSyntheticMarker as isCanonicalSyntheticMarker } from "../evals/synthetic.ts"

export function createSyntheticRunValues(input: {
  runId: string
  syntheticMarker: string
  inboundDomain: string
  routingSecret?: string
}) {
  if (!isCanonicalSyntheticMarker(input.syntheticMarker)) {
    throw new Error("A canonical synthetic marker is required for submitted run values.")
  }
  const marker = input.syntheticMarker
  const shortId = marker.replace(/^MF-EVAL-/, "")
  const numericId = Number.parseInt(shortId.slice(0, 8), 16)
  return {
    marker,
    first_name: `MF Test ${shortId}`,
    last_name: `Eval ${shortId}`,
    full_name: `Maintain Flow Test ${shortId}`,
    name: `Maintain Flow Test ${shortId}`,
    email: input.routingSecret
      ? createEvalRecipient({ runId: input.runId, secret: input.routingSecret, domain: input.inboundDomain })
      : `run-${createHash("sha256").update(input.runId).digest("hex").slice(0, 24)}@${syntheticDomain(input.inboundDomain)}`,
    company: `Maintain Flow Synthetic ${shortId}`,
    workspace: `Maintain Flow Synthetic ${shortId}`,
    message: `${marker} — synthetic business-eval submission. Please do not contact.`,
    password: `MF-${shortId}-Synthetic!9`,
    // Retained only so an already-published legacy manifest cannot submit a
    // dialable-looking value. New drafts reject telephone fields entirely.
    phone: "NOT-A-PHONE",
    number: String(100_000 + (numericId % 900_000)),
    url: `https://evals.maintainflow.test/${marker}`,
  }
}

function syntheticDomain(value: string) {
  const hostname = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error("A valid synthetic email hostname is required.")
  }
  return hostname
}

export function isSyntheticMarker(value: string) {
  return isCanonicalSyntheticMarker(value)
}
