import { validateEndpointUrlForRequest, type EndpointHostnameResolver } from "./endpoint-safety.server.ts"
import { pinnedEndpointFetch, type PinnedEndpointFetch } from "./pinned-http.server.ts"
import type { AssertionConfig, WorkflowMethod } from "./types.ts"

export type UrlScanInput = {
  clientName: string
  websiteUrl: string
  healthApiUrl?: string
}

export type UrlScanSuggestion = {
  id: string
  label: string
  reason: string
  workflow: {
    name: string
    endpointUrl: string
    method: WorkflowMethod
    expectedStatus: number
    timeoutSeconds: number
    maxLatencyMs: number
    frequencyMinutes: number
  }
  check: {
    name: string
    pluginId: "endpoint"
    assertions: AssertionConfig[]
  }
}

export type UrlScanResult = {
  baseUrl: string
  suggestions: UrlScanSuggestion[]
  warnings: string[]
}

export type UrlScanOptions = {
  fetchImpl?: typeof fetch
  pinnedFetchImpl?: PinnedEndpointFetch
  resolveHostname?: EndpointHostnameResolver
  timeoutMs?: number
  maxResponseBytes?: number
  maxSuggestions?: number
}

type FetchedPage = {
  url: string
  status: number
  contentType: string
  text: string
}

const keyPaths = ["/pricing", "/contact", "/docs", "/api", "/health"]
const defaultTimeoutMs = 6_000
const defaultMaxResponseBytes = 64_000

export async function scanUrlSuggestions(input: UrlScanInput, options: UrlScanOptions = {}): Promise<UrlScanResult> {
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? defaultTimeoutMs, 10_000))
  const maxResponseBytes = Math.max(4_000, Math.min(options.maxResponseBytes ?? defaultMaxResponseBytes, 128_000))
  const maxSuggestions = Math.max(1, Math.min(options.maxSuggestions ?? 6, 10))
  const baseSafety = await validateEndpointUrlForRequest(normalizeUrl(input.websiteUrl), options.resolveHostname)
  if (!baseSafety.ok) {
    return { baseUrl: "", suggestions: [], warnings: [baseSafety.reason] }
  }

  const warnings: string[] = []
  const suggestions: UrlScanSuggestion[] = []
  const homepage = await fetchSafePage(baseSafety.url.toString(), { fetchImpl: options.fetchImpl, pinnedFetchImpl: options.pinnedFetchImpl, resolveHostname: options.resolveHostname, timeoutMs, maxResponseBytes })
  if (!homepage.ok) {
    warnings.push(homepage.reason)
  } else {
    suggestions.push(homepageSuggestion(input.clientName, homepage.page))
    const discoveredPaths = discoverKeyPaths(homepage.page.text)
    for (const path of discoveredPaths) {
      if (suggestions.length >= maxSuggestions) break
      const url = new URL(path, baseSafety.url).toString()
      const page = await fetchSafePage(url, { fetchImpl: options.fetchImpl, pinnedFetchImpl: options.pinnedFetchImpl, resolveHostname: options.resolveHostname, timeoutMs, maxResponseBytes })
      if (!page.ok) {
        warnings.push(page.reason)
        continue
      }
      suggestions.push(pathSuggestion(input.clientName, path, page.page))
    }
  }

  if (input.healthApiUrl && suggestions.length < maxSuggestions) {
    const healthUrl = normalizeUrl(input.healthApiUrl)
    const page = await fetchSafePage(healthUrl, { fetchImpl: options.fetchImpl, pinnedFetchImpl: options.pinnedFetchImpl, resolveHostname: options.resolveHostname, timeoutMs, maxResponseBytes })
    if (!page.ok) {
      warnings.push(page.reason)
    } else {
      suggestions.push(apiSuggestion(input.clientName, page.page))
    }
  }

  return {
    baseUrl: baseSafety.url.toString(),
    suggestions: dedupeSuggestions(suggestions).slice(0, maxSuggestions),
    warnings,
  }
}

function homepageSuggestion(clientName: string, page: FetchedPage): UrlScanSuggestion {
  const title = pageTitle(page.text)
  return {
    id: suggestionId("homepage", page.url),
    label: "Homepage health",
    reason: title ? `Homepage returned HTTP ${page.status} and includes the title "${title}".` : `Homepage returned HTTP ${page.status}.`,
    workflow: workflowDefaults(`${clientName || "Client"} homepage`, page.url),
    check: {
      name: "Homepage response check",
      pluginId: "endpoint",
      assertions: [assertion("response-exists", "response_exists")],
    },
  }
}

function pathSuggestion(clientName: string, path: string, page: FetchedPage): UrlScanSuggestion {
  const label = pathLabel(path)
  return {
    id: suggestionId(path.replace(/[^a-z0-9]+/gi, "-"), page.url),
    label: `${label} page health`,
    reason: `${path} was detected from the homepage and returned HTTP ${page.status}.`,
    workflow: workflowDefaults(`${clientName || "Client"} ${label}`, page.url),
    check: {
      name: `${label} page response check`,
      pluginId: "endpoint",
      assertions: [assertion("response-exists", "response_exists")],
    },
  }
}

function apiSuggestion(clientName: string, page: FetchedPage): UrlScanSuggestion {
  const jsonAssertion = jsonFieldAssertion(page.text)
  return {
    id: suggestionId("api-health", page.url),
    label: "API or health endpoint",
    reason: jsonAssertion
      ? `Endpoint returned JSON with field "${jsonAssertion.path}".`
      : `Endpoint returned HTTP ${page.status}.`,
    workflow: workflowDefaults(`${clientName || "Client"} API health`, page.url),
    check: {
      name: "API health check",
      pluginId: "endpoint",
      assertions: [
        assertion("response-exists", "response_exists"),
        ...(jsonAssertion ? [jsonAssertion] : []),
      ],
    },
  }
}

function workflowDefaults(name: string, endpointUrl: string) {
  return {
    name,
    endpointUrl,
    method: "GET" as const,
    expectedStatus: 200,
    timeoutSeconds: 10,
    maxLatencyMs: 5_000,
    frequencyMinutes: 60,
  }
}

function assertion(id: string, type: "response_exists"): AssertionConfig {
  return { id, type, enabled: true }
}

function jsonFieldAssertion(text: string): AssertionConfig | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    const [firstKey] = Object.keys(parsed)
    return firstKey ? { id: `json-${firstKey}-exists`, type: "json_field_exists", path: firstKey, enabled: true } : null
  } catch {
    return null
  }
}

async function fetchSafePage(url: string, options: Pick<UrlScanOptions, "fetchImpl" | "pinnedFetchImpl" | "resolveHostname" | "timeoutMs" | "maxResponseBytes">): Promise<{ ok: true; page: FetchedPage } | { ok: false; reason: string }> {
  const safety = await validateEndpointUrlForRequest(url, options.resolveHostname)
  if (!safety.ok) {
    return { ok: false, reason: safety.reason }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs)
  try {
    const requestInit: RequestInit = {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    }
    const response = options.fetchImpl
      ? await options.fetchImpl(safety.url, requestInit)
      : await (options.pinnedFetchImpl ?? pinnedEndpointFetch)(safety.url, safety.addresses, requestInit)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      if (!location) {
        return { ok: false, reason: `${safety.url.toString()} redirects without a Location header.` }
      }
      const redirectSafety = await validateEndpointUrlForRequest(new URL(location, safety.url).toString(), options.resolveHostname)
      return redirectSafety.ok
        ? { ok: false, reason: `${safety.url.toString()} redirects. Suggestions do not follow redirects automatically.` }
        : { ok: false, reason: `Redirect blocked: ${redirectSafety.reason}` }
    }
    const text = await readLimitedResponse(response, options.maxResponseBytes ?? defaultMaxResponseBytes)
    return {
      ok: true,
      page: {
        url: safety.url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type") ?? "text/plain",
        text,
      },
    }
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? `${safety.url.toString()} timed out during scan.`
      : error instanceof Error
        ? error.message
        : "URL scan request failed."
    return { ok: false, reason }
  } finally {
    clearTimeout(timeout)
  }
}

async function readLimitedResponse(response: Response, maxBytes: number) {
  const reader = response.body?.getReader()
  if (!reader) return ""

  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxBytes) {
      throw new Error(`Response exceeded the ${Math.round(maxBytes / 1000)} KB URL scan cap.`)
    }
    chunks.push(value)
  }

  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(output)
}

function discoverKeyPaths(html: string) {
  const paths = new Set<string>()
  const hrefPattern = /href=["']([^"'#?]+)(?:[#?][^"']*)?["']/gi
  let match: RegExpExecArray | null
  while ((match = hrefPattern.exec(html))) {
    const value = match[1]
    if (!value.startsWith("/")) continue
    const normalized = value.replace(/\/+$/, "") || "/"
    if (keyPaths.includes(normalized)) {
      paths.add(normalized)
    }
  }
  return Array.from(paths)
}

function pageTitle(html: string) {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
  return title?.replace(/\s+/g, " ").trim().slice(0, 80) ?? ""
}

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ""
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function pathLabel(path: string) {
  return path.replace(/^\//, "").replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Homepage"
}

function suggestionId(prefix: string, url: string) {
  return `${prefix}-${url.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}`
}

function dedupeSuggestions(suggestions: UrlScanSuggestion[]) {
  const seen = new Set<string>()
  return suggestions.filter((suggestion) => {
    const key = suggestion.workflow.endpointUrl
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
