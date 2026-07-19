import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The legacy application endpoint is intentionally retired. Keep a clear 410
 * response so stale clients cannot create founder-led sales obligations.
 */
export async function POST() {
  return NextResponse.json(
    {
      message: "The sales application has been retired. Create a Free workspace instead.",
      signupUrl: "/sign-up",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    }
  )
}
