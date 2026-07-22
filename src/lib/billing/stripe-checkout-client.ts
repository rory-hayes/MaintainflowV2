"use client"

import { getValidSupabaseAccessToken } from "@/lib/supabase/auth"

export type StripeCheckoutReturnPayload = {
  status: "active" | "pending" | "expired"
  planId: string
  interval: string
  subscriptionStatus: string
  message: string
}

export async function reconcileStripeCheckoutFromBrowser(input: {
  workspaceId: string
  sessionId: string
}) {
  const token = await getValidSupabaseAccessToken()
  if (!token) throw new Error("Sign in again before confirming Stripe checkout.")
  if (!input.workspaceId) throw new Error("Select a workspace before confirming Stripe checkout.")
  const response = await fetch("/api/billing/checkout/reconcile", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-MaintainFlow-Workspace-Id": input.workspaceId,
    },
    body: JSON.stringify({ sessionId: input.sessionId }),
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => ({}))) as Partial<StripeCheckoutReturnPayload> & { error?: string }
  if (
    !response.ok
    || (payload.status !== "active" && payload.status !== "pending" && payload.status !== "expired")
    || typeof payload.message !== "string"
  ) {
    throw new Error(payload.error || "Stripe checkout could not be confirmed.")
  }
  return payload as StripeCheckoutReturnPayload
}
