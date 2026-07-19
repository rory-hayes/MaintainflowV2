import "server-only"

import type { Page, Request as PlaywrightRequest, Route } from "playwright-core"

import { validateEndpointUrlForRequest } from "@/lib/core/endpoint-safety.server"
import { pinnedEndpointFetch } from "@/lib/core/pinned-http.server"

const MAX_BROWSER_RESPONSE_BYTES = 20 * 1024 * 1024
export type BrowserNetworkMode = "pinned_worker" | "external_proxy"
export type BrowserDestinationGuards = {
  assertExecutionAllowed?: () => Promise<void>
  consumeDestination?: (url: URL) => Promise<void>
}
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export class BrowserSafetyError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BrowserSafetyError"
    this.code = code
  }
}

export async function assertPublicBrowserTarget(input: string, allowedHosts: string[]) {
  const target = await resolvePublicBrowserTarget(input)
  const host = target.url.hostname.toLowerCase()
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new BrowserSafetyError("HOST_NOT_ALLOWLISTED", `Navigation to ${host} is not authorized for this project.`)
  }

  return target
}

export async function resolvePublicBrowserTarget(input: string) {
  const safety = await validateEndpointUrlForRequest(input)
  if (!safety.ok) {
    throw new BrowserSafetyError("BLOCKED_TARGET", safety.reason)
  }

  if (safety.url.protocol !== "https:") {
    throw new BrowserSafetyError("HTTPS_REQUIRED", "Business evals may target only public HTTPS pages.")
  }

  const host = safety.url.hostname.toLowerCase()
  const denylist = configuredDomainDenylist()
  if (denylist.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
    throw new BrowserSafetyError("DOMAIN_DENIED", `${host} is blocked by the Maintain Flow safety denylist.`)
  }
  return { url: safety.url, addresses: [...safety.addresses].sort() }
}

export async function installTopLevelNavigationGuard(
  page: Page,
  allowedHosts: string[],
  networkMode: BrowserNetworkMode = "pinned_worker",
  guards: BrowserDestinationGuards = {}
) {
  const firstResolution = new Map<string, string[]>()
  const consumedDestinations = new Map<string, Promise<void>>()

  // Playwright routing cannot safely proxy WebSocket sockets to a prevalidated
  // IP. Blocking them is preferable to letting Chromium perform a second,
  // unpinned DNS lookup behind the HTTP guard.
  const context = page.context()
  await context.routeWebSocket("**/*", async (socket) => {
    await socket.close({ code: 1008, reason: "WebSockets are outside the restricted business-eval manifest." })
  })

  // The remote Browserbase default context cannot be recreated with
  // serviceWorkers: "block". Bypass existing workers at the CDP network layer
  // so every HTTP request reaches the pinned route below.
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")
  await cdp.send("Network.setBypassServiceWorker", { bypass: true })

  await context.route("**/*", async (route) => {
    const request = route.request()

    try {
      const protocol = new URL(request.url()).protocol.toLowerCase()
      if (protocol !== "https:") {
        throw new BrowserSafetyError(
          "UNSUPPORTED_SCHEME",
          `Browser eval network requests must use public HTTPS; ${protocol || "unknown"} is blocked.`
        )
      }
      const requiresAuthorization = requiresDestinationAuthorization(request)
      const target = requiresAuthorization
        ? await assertPublicBrowserTarget(request.url(), allowedHosts)
        : await resolvePublicBrowserTarget(request.url())
      if (requiresAuthorization) {
        // The execution control is intentionally not deduplicated: it closes
        // the window between a page load and a later form POST or redirect.
        await guards.assertExecutionAllowed?.()
        if (guards.consumeDestination) {
          const destinationKey = target.url.hostname.toLowerCase()
          let consumed = consumedDestinations.get(destinationKey)
          if (!consumed) {
            consumed = guards.consumeDestination(target.url)
            consumedDestinations.set(destinationKey, consumed)
          }
          await consumed
        }
      }
      const previous = firstResolution.get(target.url.hostname)
      if (previous && previous.join(",") !== target.addresses.join(",")) {
        throw new BrowserSafetyError("DNS_REBINDING_BLOCKED", "The destination changed addresses during this run.")
      }
      firstResolution.set(target.url.hostname, target.addresses)
      if (networkMode === "external_proxy") {
        // Browserbase sessions have exactly one authenticated catch-all proxy.
        // The in-process check rejects unsafe destinations before the browser
        // continues; the proxy closes the connection-time DNS TOCTOU window.
        await route.continue()
      } else {
        // Local fixture sessions have no production proxy policy, so they may
        // connect only to the exact public address resolved above.
        await fulfillFromPinnedPublicAddress(route, target.url, target.addresses)
      }
    } catch (error) {
      await route.abort("blockedbyclient")
      throw error
    }
  })
}

async function fulfillFromPinnedPublicAddress(route: Route, url: URL, validatedAddresses: string[]) {
  const request = route.request()
  const headers = new Headers(request.headers())
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)
  headers.delete("host")

  const body = request.postDataBuffer() ?? undefined
  const response = await pinnedEndpointFetch(url, validatedAddresses, {
    method: request.method(),
    headers,
    body: body as unknown as BodyInit | undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  })
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BROWSER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new BrowserSafetyError("RESPONSE_TOO_LARGE", "The destination response exceeded the safe browser-eval limit.")
  }

  const responseBody = await readBoundedResponse(response)
  const responseHeaders: Record<string, string> = {}
  for (const [name, value] of response.headers.entries()) {
    if (
      !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
      && name.toLowerCase() !== "content-length"
      && name.toLowerCase() !== "set-cookie"
    ) {
      responseHeaders[name] = value
    }
  }
  const setCookies = response.headers.getSetCookie()
  if (setCookies.length) responseHeaders["set-cookie"] = setCookies.join("\n")
  await route.fulfill({
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
  })
}

async function readBoundedResponse(response: Response) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BROWSER_RESPONSE_BYTES) {
        throw new BrowserSafetyError("RESPONSE_TOO_LARGE", "The destination response exceeded the safe browser-eval limit.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export async function assertNavigationStayedPublic(page: Page, allowedHosts: string[]) {
  return assertPublicBrowserTarget(page.url(), allowedHosts)
}

export async function pageContainsCaptcha(page: Page) {
  const selectors = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "[data-sitekey]",
    "[class*='captcha' i]",
    "[id*='captcha' i]",
  ]
  for (const selector of selectors) {
    if (await page.locator(selector).count()) return true
  }

  const bodyText = (await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "")).toLowerCase()
  return bodyText.includes("verify you are human") || bodyText.includes("security challenge")
}

function requiresDestinationAuthorization(request: PlaywrightRequest) {
  const topLevelNavigation = request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame()
  const sideEffectingRequest = !["GET", "HEAD", "OPTIONS"].includes(request.method().toUpperCase())
  return topLevelNavigation || sideEffectingRequest
}

function configuredDomainDenylist() {
  return (process.env.BUSINESS_EVALS_DOMAIN_DENYLIST ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
}
