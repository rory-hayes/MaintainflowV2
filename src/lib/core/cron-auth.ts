import { timingSafeEqual } from "crypto"

export function isAuthorizedCronRequest(authorizationHeader: string | null, secret: string | undefined) {
  if (!secret || !authorizationHeader?.startsWith("Bearer ")) {
    return false
  }

  const provided = authorizationHeader.slice("Bearer ".length)
  const expected = secret.trim()

  if (!provided || !expected) {
    return false
  }

  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)

  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)
}
