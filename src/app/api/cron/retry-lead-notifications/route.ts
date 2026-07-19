import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function retiredResponse() {
  return NextResponse.json(
    {
      ok: false,
      message: "Paid-pilot lead notifications have been retired.",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    }
  )
}

export async function POST() {
  return retiredResponse()
}

export async function GET() {
  return retiredResponse()
}
