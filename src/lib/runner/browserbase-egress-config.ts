import { isIP } from "node:net"

export type BrowserbaseExternalEgressProxy = {
  type: "external"
  server: string
  username: string
  password: string
}

const REQUIRED_PROXY_KEYS = [
  "BROWSERBASE_EGRESS_PROXY_SERVER",
  "BROWSERBASE_EGRESS_PROXY_USERNAME",
  "BROWSERBASE_EGRESS_PROXY_PASSWORD",
] as const

/**
 * Build the one permitted Browserbase production egress rule.
 *
 * Omitting domainPattern is deliberate: Browserbase documents an omitted pattern
 * as the catch-all rule. Do not add a `none` or Browserbase-managed fallback.
 */
export function requireBrowserbaseExternalEgressProxy(
  env: Partial<Record<string, string | undefined>> = process.env
): BrowserbaseExternalEgressProxy {
  const missing = REQUIRED_PROXY_KEYS.filter((key) => !env[key]?.trim())
  if (missing.length) {
    throw new Error(`Browserbase external egress proxy configuration is incomplete; missing ${missing.join(", ")}.`)
  }

  const server = env.BROWSERBASE_EGRESS_PROXY_SERVER!.trim()
  const username = env.BROWSERBASE_EGRESS_PROXY_USERNAME!.trim()
  const password = env.BROWSERBASE_EGRESS_PROXY_PASSWORD!.trim()
  let parsed: URL
  try {
    parsed = new URL(server)
  } catch {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must be a valid HTTPS proxy origin.")
  }

  if (parsed.protocol !== "https:") {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must use HTTPS so proxy credentials are encrypted in transit.")
  }
  if (parsed.username || parsed.password) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must not embed credentials; use the dedicated username and password variables.")
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must be an origin without a path, query, or fragment.")
  }

  const hostname = parsed.hostname.toLowerCase()
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, "")
  const reservedSuffixes = [".localhost", ".local", ".internal", ".home", ".lan", ".test", ".invalid", ".onion"]
  if (
    !hostname
    || !hostname.includes(".")
    || hostname === "localhost"
    || reservedSuffixes.some((suffix) => hostname.endsWith(suffix))
    || isIP(unbracketedHostname)
  ) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must use a public DNS hostname, not localhost or an IP literal.")
  }
  if (/\s/.test(username) || username.length > 256) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_USERNAME must be a non-empty proxy username without whitespace.")
  }
  if (password.length < 16 || password.length > 1_024) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_PASSWORD must contain between 16 and 1024 characters.")
  }

  return {
    type: "external",
    server: parsed.origin,
    username,
    password,
  }
}
