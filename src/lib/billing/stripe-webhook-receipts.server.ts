import "server-only"

import { createHash } from "node:crypto"

import { supabaseServiceJson } from "@/lib/supabase/server"

type ReceiptRow = {
  receipt_id: string
  receipt_status: "processing" | "processed" | "failed"
  claimed: boolean
  claim_token: string
  attempt_count: number
}

export type StripeWebhookReceiptClaim = {
  id: string
  status: ReceiptRow["receipt_status"]
  claimed: boolean
  claimToken: string
  attemptCount: number
  payloadHash: string
}

export async function claimStripeWebhookReceipt(input: {
  eventId: string
  eventType: string
  rawPayload: string
}): Promise<StripeWebhookReceiptClaim> {
  const payloadHash = createHash("sha256").update(input.rawPayload).digest("hex")
  const rows = await supabaseServiceJson<ReceiptRow[]>("rpc/claim_provider_webhook_receipt", {
    method: "POST",
    body: JSON.stringify({
      p_provider: "stripe",
      p_event_id: input.eventId,
      p_event_type: input.eventType,
      p_payload_hash: payloadHash,
      p_stale_after_seconds: 300,
    }),
  })
  const row = rows[0]
  if (!row) throw new Error("Stripe webhook receipt claim was not returned.")
  return {
    id: String(row.receipt_id),
    status: row.receipt_status,
    claimed: Boolean(row.claimed),
    claimToken: String(row.claim_token),
    attemptCount: Number(row.attempt_count),
    payloadHash,
  }
}

export async function finishStripeWebhookReceipt(
  receipt: StripeWebhookReceiptClaim,
  succeeded: boolean
) {
  const rows = await supabaseServiceJson<Array<{ id: string; status: string }>>(
    "rpc/finish_provider_webhook_receipt",
    {
      method: "POST",
      body: JSON.stringify({
        p_receipt_id: receipt.id,
        p_claim_token: receipt.claimToken,
        p_payload_hash: receipt.payloadHash,
        p_succeeded: succeeded,
        p_last_error_safe: succeeded ? "" : "Stripe webhook processing failed.",
      }),
    }
  )
  if (!rows[0]) throw new Error("Stripe webhook receipt could not be finalized.")
  return rows[0]
}
