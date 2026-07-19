import { InboundWebhookError, processResendInboundWebhook } from "@/lib/email/resend-inbound.server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const rawBody = await request.text()
    const data = await processResendInboundWebhook({
      rawBody,
      webhookId: request.headers.get("svix-id") ?? "",
      webhookTimestamp: request.headers.get("svix-timestamp") ?? "",
      webhookSignature: request.headers.get("svix-signature") ?? "",
    })
    return Response.json({ ok: true, data }, { status: 202 })
  } catch (error) {
    if (error instanceof InboundWebhookError) {
      return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status })
    }
    console.error("[resend-inbound]", error instanceof Error ? error.message : "unknown error")
    return Response.json({ ok: false, error: { code: "INBOUND_FAILED", message: "The inbound email event could not be accepted." } }, { status: 500 })
  }
}
