import { timingSafeEqual } from "node:crypto"

export function isBusinessEvalsPreviewRequestAllowed(input: {
  env: Partial<Record<string, string | undefined>>
  presentedToken?: string | null
}) {
  const { env } = input
  if (env.BUSINESS_EVALS_PREVIEW !== "1") return false
  if (env.NODE_ENV !== "production") return true
  if (env.VERCEL || env.VERCEL_ENV || env.NEXT_PUBLIC_VERCEL_ENV) return false

  const expected = env.BUSINESS_EVALS_E2E_PREVIEW_TOKEN?.trim() ?? ""
  const presented = input.presentedToken?.trim() ?? ""
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(presented)) return false
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(presented, "utf8"))
}
