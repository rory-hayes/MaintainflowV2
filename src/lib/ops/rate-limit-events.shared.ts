import { createHash } from "node:crypto"

export function hashRateLimitKey(scope: string, key: string, pepper = "") {
  return createHash("sha256")
    .update(`${scope}:${key}:${pepper}`)
    .digest("hex")
}
