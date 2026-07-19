import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { validateEndpointUrl, type UrlSafetyResult } from "./security.ts"

export type EndpointHostnameResolver = (hostname: string) => Promise<string[]>
export type RequestUrlSafetyResult =
  | { ok: true; url: URL; addresses: string[] }
  | Extract<UrlSafetyResult, { ok: false }>

export async function validateEndpointUrlForRequest(
  input: string,
  resolveHostname: EndpointHostnameResolver = resolveEndpointHostname,
  options: { allowSyntheticDemo?: boolean } = {},
): Promise<RequestUrlSafetyResult> {
  const result = validateEndpointUrl(input)
  if (!result.ok) {
    return result
  }

  if (result.url.hostname === "demo.maintainflow.test") {
    if (!(options.allowSyntheticDemo ?? syntheticDemoEndpointAllowed())) {
      return { ok: false, reason: "Synthetic demo endpoints are disabled in production." }
    }
    return { ...result, addresses: [] }
  }

  const hostname = result.url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      return { ok: false, reason: `Endpoint URL uses a blocked internal address (${hostname}).` }
    }
    return { ...result, addresses: [hostname] }
  }

  if (/^\d+$/.test(hostname)) {
    return { ok: false, reason: "Numeric hostnames are blocked for endpoint safety." }
  }

  let addresses: string[]
  try {
    addresses = await resolveHostname(hostname)
  } catch {
    return { ok: false, reason: "Could not resolve the endpoint hostname." }
  }

  if (addresses.length === 0) {
    return { ok: false, reason: "Could not resolve the endpoint hostname." }
  }

  const blockedAddress = addresses.find(isBlockedIpAddress)
  if (blockedAddress) {
    return {
      ok: false,
      reason: `Endpoint hostname resolves to a blocked internal address (${blockedAddress}).`,
    }
  }

  return { ...result, addresses }
}

export function syntheticDemoEndpointAllowed() {
  return process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production"
}

export async function resolveEndpointHostname(hostname: string) {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export function isBlockedIpAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase()
  const ipv4FromMapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  if (ipv4FromMapped) {
    return isBlockedIpv4Address(ipv4FromMapped)
  }

  const ipVersion = isIP(normalized)
  if (ipVersion === 4) {
    return isBlockedIpv4Address(normalized)
  }

  if (ipVersion === 6) {
    return isBlockedIpv6Address(normalized)
  }

  return true
}

function isBlockedIpv4Address(address: string) {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  const [first, second] = parts
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && parts[2] === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && [18, 19].includes(second))
  )
}

function isBlockedIpv6Address(address: string) {
  const mappedHex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    return isBlockedIpv4Address([
      high >> 8,
      high & 0xff,
      low >> 8,
      low & 0xff,
    ].join("."))
  }

  const firstGroup = parseInt(address.split(":")[0] || "0", 16)
  if (firstGroup < 0x2000 || firstGroup > 0x3fff) return true

  return address.startsWith("2001:db8:")
    || address.startsWith("2001:db8::")
    || address.startsWith("2001:0:")
    || address.startsWith("2002:")
    || address.startsWith("64:ff9b:")
}
