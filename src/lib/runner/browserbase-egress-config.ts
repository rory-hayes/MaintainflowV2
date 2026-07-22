import { isIP } from "node:net"

export type BrowserbaseExternalEgressProxy = {
  type: "external"
  server: string
  username: string
  password: string
}

export type BrowserbaseExternalEgressConfiguration = {
  proxies: [BrowserbaseExternalEgressProxy]
  proxySettings: {
    caCertificates: [string]
  }
}

export type BrowserbaseProxySessionCredentials = {
  username: string
  password: string
}

const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

const REQUIRED_PROXY_KEYS = [
  "BROWSERBASE_EGRESS_PROXY_SERVER",
  "BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID",
] as const

/**
 * Build the one permitted Browserbase production egress configuration.
 *
 * Omitting domainPattern is deliberate: Browserbase documents an omitted pattern
 * as the catch-all rule. The reviewed public CA certificate is inseparable from
 * that rule so the TLS-intercepting gateway never depends on disabling normal
 * certificate validation. Do not add a `none` or Browserbase-managed fallback.
 */
export function requireBrowserbaseExternalEgressConfiguration(
  credentials: BrowserbaseProxySessionCredentials,
  env: Partial<Record<string, string | undefined>> = process.env
): BrowserbaseExternalEgressConfiguration {
  const missing = REQUIRED_PROXY_KEYS.filter((key) => !env[key]?.trim())
  if (missing.length) {
    throw new Error(`Browserbase external egress proxy configuration is incomplete; missing ${missing.join(", ")}.`)
  }

  const server = env.BROWSERBASE_EGRESS_PROXY_SERVER!.trim()
  const username = credentials.username.trim()
  const password = credentials.password.trim()
  const caCertificateId = env.BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID!.trim()
  let parsed: URL
  try {
    parsed = new URL(server)
  } catch {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must be a valid HTTPS proxy origin.")
  }

  if (parsed.protocol !== "https:") {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must use HTTPS so proxy credentials are encrypted in transit.")
  }
  if (parsed.port) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must use the dedicated HTTPS proxy on port 443.")
  }
  if (parsed.username || parsed.password) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_SERVER must not embed credentials; per-session credentials are supplied separately.")
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
  if (!/^mf1\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(username)) {
    throw new Error("The per-session browser proxy username is invalid.")
  }
  const passwordBytes = Buffer.byteLength(password, "ascii")
  if (passwordBytes < 64 || passwordBytes > 1_024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error("The per-session browser proxy token is invalid.")
  }
  if (
    !SAFE_PROVIDER_ID.test(caCertificateId)
  ) {
    throw new Error("BROWSERBASE_EGRESS_PROXY_CA_CERTIFICATE_ID must be one structurally safe Browserbase certificate ID.")
  }

  return {
    proxies: [{
      type: "external",
      server: parsed.origin,
      username,
      password,
    }],
    proxySettings: {
      caCertificates: [caCertificateId],
    },
  }
}

export function requireBrowserbaseProjectId(
  env: Partial<Record<string, string | undefined>> = process.env
) {
  const projectId = env.BROWSERBASE_PROJECT_ID?.trim() ?? ""
  if (!SAFE_PROVIDER_ID.test(projectId)) {
    throw new Error("BROWSERBASE_PROJECT_ID must identify one reviewed Browserbase project.")
  }
  return projectId
}
