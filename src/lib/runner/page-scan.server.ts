import "server-only"

import Browserbase from "@browserbasehq/sdk"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

import { requireBrowserbaseExternalEgressConfiguration, requireBrowserbaseProjectId } from "@/lib/runner/browserbase-egress-config"
import { requireBrowserbaseAllowedDomains } from "@/lib/runner/browser-context-policy"
import { issueBrowserProxyCredentials } from "@/lib/runner/browser-proxy-credentials.server"
import { requestBrowserbaseSessionReleaseIfStranded } from "@/lib/runner/browserbase-lifecycle.server"
import {
  assertBrowserbaseSessionCommerciallyAllowed,
  markBrowserbaseSessionCreationUncertain,
  prepareBrowserbaseSessionCreation,
  recordTerminalBrowserbaseSessionUsage,
  registerBrowserbaseSessionForMetering,
  type BrowserbaseSessionMeteringRegistration,
} from "@/lib/runner/browserbase-usage-control.server"
import { assertNavigationStayedPublic, assertPublicBrowserTarget, installTopLevelNavigationGuard, pageContainsCaptcha, type BrowserNetworkMode } from "@/lib/runner/browser-safety.server"
import { selectUnambiguousSubmitActions } from "@/lib/runner/page-scan-actions"

export type DetectedField = {
  key: string
  control: "input" | "textarea" | "select"
  inputType: string
  label: string
  name: string
  required: boolean
  options: Array<{ value: string; label: string; disabled: boolean }>
  locator:
    | { kind: "label"; value: string }
    | { kind: "placeholder"; value: string }
    | { kind: "test_id"; value: string }
    | null
}

export type DetectedAction = {
  key: string
  label: string
  role: "button"
  locator: { kind: "role"; role: "button"; name: string }
}

export type JourneyPageScan = {
  url: string
  title: string
  captchaDetected: boolean
  fields: DetectedField[]
  actions: DetectedAction[]
  warnings: string[]
}

export async function scanJourneyPage(input: {
  url: string
  agencyId: string
  projectId: string
  allowedHosts: string[]
}): Promise<JourneyPageScan> {
  // The project authorization is the source of truth for every top-level
  // navigation, including an approved cross-host redirect. Reducing this to
  // the starting hostname would incorrectly block an attested redirect while
  // still returning the broader list to the builder as if it had been used.
  const allowedDomains = requireBrowserbaseAllowedDomains(input.allowedHosts)
  const target = await assertPublicBrowserTarget(input.url, allowedDomains)
  const connection = await connectScanBrowser(allowedDomains, {
    agencyId: input.agencyId,
    projectId: input.projectId,
  })
  try {
    await installTopLevelNavigationGuard(connection.page, allowedDomains, connection.networkMode, { blockSideEffects: true })
    const response = await connection.page.goto(target.url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    })
    if (!response) throw new Error("The page did not return a navigation response.")
    await assertNavigationStayedPublic(connection.page, allowedDomains)

    const captchaDetected = await pageContainsCaptcha(connection.page)
    const fields = await detectFields(connection.page)
    const actions = await detectActions(connection.page)
    const warnings: string[] = []
    if (captchaDetected) warnings.push("A CAPTCHA was detected. This journey cannot be scheduled.")
    if (!fields.length) warnings.push("No supported form fields were detected on this page.")
    if (!actions.length) warnings.push("No unambiguous form submit control was detected.")

    return {
      url: (await assertNavigationStayedPublic(connection.page, allowedDomains)).url.toString(),
      title: (await connection.page.title()).slice(0, 200),
      captchaDetected,
      fields,
      actions,
      warnings,
    }
  } finally {
    await connection.close()
  }
}

async function connectScanBrowser(approvedHosts: string[], accounting: {
  agencyId: string
  projectId: string
}): Promise<{
  browser: Browser
  context: BrowserContext
  page: Page
  networkMode: BrowserNetworkMode
  close: () => Promise<void>
}> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim()
  if (process.env.NODE_ENV === "production" && !apiKey) {
    throw new Error("Browserbase is required for production page scans.")
  }

  if (apiKey) {
    // Session creation is non-idempotent. Do not let the SDK replay an
    // ambiguous provider mutation; the 300-second provider timeout bounds any
    // session whose response is lost before we receive its identifier.
    const client = new Browserbase({ apiKey, maxRetries: 0, timeout: 30_000 })
    const projectId = requireBrowserbaseProjectId(process.env)
    const allowedDomains = requireBrowserbaseAllowedDomains(approvedHosts)
    // Page scans are read-only. The canonical target hostname is a stable,
    // non-secret subject; the empty side-effect scope makes all mutation-class
    // requests fail at the gateway even if page behavior is hostile.
    const proxyCredentials = issueBrowserProxyCredentials({
      subject: `scan:${allowedDomains[0]}`,
      sideEffectHosts: [],
    })
    const externalEgress = requireBrowserbaseExternalEgressConfiguration(proxyCredentials, process.env)
    await assertBrowserbaseSessionCommerciallyAllowed({ client, projectId })
    const purpose = { kind: "page_scan" as const, ...accounting }
    const creationIntent = await prepareBrowserbaseSessionCreation({
      browserbaseProjectId: projectId,
      purpose,
    })
    let session
    try {
      session = await client.sessions.create({
        projectId,
        keepAlive: false,
        timeout: 300,
        // Opaque correlation supports recovery from a lost create response;
        // it intentionally contains no workspace, Project, URL, or user data.
        userMetadata: { mf_intent: creationIntent.correlationToken },
        // No domainPattern means catch-all. Never add a direct, `none`, or
        // Browserbase-managed fallback to this production security boundary.
        proxies: externalEgress.proxies,
        proxySettings: externalEgress.proxySettings,
        region: "eu-central-1",
        browserSettings: {
          // This is a provider-side top-level navigation guard only. The
          // catch-all external proxy remains mandatory for every subresource,
          // frame, worker, WebSocket, redirect, and DNS resolution.
          allowedDomains,
          advancedStealth: false,
          solveCaptchas: false,
          recordSession: false,
          logSession: false,
          ignoreCertificateErrors: false,
        },
      })
    } catch {
      await markBrowserbaseSessionCreationUncertain({
        browserbaseProjectId: projectId,
        creationIntentId: creationIntent.id,
        reason: "create_response_ambiguous",
      }).catch(() => undefined)
      throw new Error("Browserbase rejected or ambiguously answered the policy-constrained scan session configuration.")
    }
    const meteringRegistration = await registerBrowserbaseSessionForMetering({
      client,
      browserbaseProjectId: projectId,
      providerSessionId: session.id,
      creationIntent,
    })
    const browser = await chromium.connectOverCDP(session.connectUrl).catch(async () => {
      await releaseAndMeterScanSession(client, meteringRegistration)
      throw new Error("The Browserbase scan session connection failed securely.")
    })
    const context = browser.contexts()[0]
    const page = context?.pages()[0]
    if (!context || !page) {
      await browser.close().catch(() => undefined)
      await releaseAndMeterScanSession(client, meteringRegistration)
      throw new Error("Browserbase did not expose its default recorded context.")
    }
    return {
      browser,
      context,
      page,
      networkMode: "external_proxy",
      close: async () => {
        await browser.close().catch(() => undefined)
        await releaseAndMeterScanSession(client, meteringRegistration)
      },
    }
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: false })
  const page = await context.newPage()
  return { browser, context, page, networkMode: "pinned_worker", close: () => browser.close() }
}

async function releaseAndMeterScanSession(
  client: Browserbase,
  registration: BrowserbaseSessionMeteringRegistration
) {
  let releaseError: unknown
  try {
    await requestBrowserbaseSessionReleaseIfStranded(
      client,
      registration.providerSessionId,
      registration.browserbaseProjectId
    )
  } catch (error) {
    releaseError = error
  }
  let meteringError: unknown
  try {
    await recordTerminalBrowserbaseSessionUsage({ client, registration })
  } catch (error) {
    meteringError = error
  }
  if (releaseError) throw releaseError
  if (meteringError) throw meteringError
}

async function detectFields(page: Page): Promise<DetectedField[]> {
  const raw = await page.locator("input:not([type=hidden]), textarea, select").evaluateAll((nodes) =>
    nodes.slice(0, 80).map((node, index) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      const id = element.id
      const explicitLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : ""
      const wrappedLabel = element.closest("label")?.textContent
      const ariaLabel = element.getAttribute("aria-label")
      return {
        index,
        tag: element.tagName.toLowerCase(),
        type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
        name: element.getAttribute("name") ?? "",
        label: (explicitLabel || wrappedLabel || ariaLabel || "").trim().replace(/\s+/g, " ").slice(0, 200),
        placeholder: element.getAttribute("placeholder")?.trim().slice(0, 200) ?? "",
        testId: element.getAttribute("data-testid")?.trim().slice(0, 200) ?? "",
        required: element.matches(":required") || element.getAttribute("aria-required") === "true",
        options: element instanceof HTMLSelectElement
          ? Array.from(element.options).slice(0, 100).map((option) => ({
              value: option.value.slice(0, 500),
              label: option.textContent?.trim().replace(/\s+/g, " ").slice(0, 200) || option.value.slice(0, 200),
              disabled: option.disabled,
            }))
          : element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
            ? [{
                value: element.value.slice(0, 500),
                label: (explicitLabel || wrappedLabel || ariaLabel || element.value).trim().replace(/\s+/g, " ").slice(0, 200),
                disabled: element.disabled,
              }]
            : [],
      }
    })
  )

  const seen = new Set<string>()
  return raw.flatMap((field) => {
    const locator = field.label
      ? { kind: "label" as const, value: field.label }
      : field.placeholder
        ? { kind: "placeholder" as const, value: field.placeholder }
        : field.testId
          ? { kind: "test_id" as const, value: field.testId }
          : null
    const fingerprint = JSON.stringify(locator)
    if (!locator || seen.has(fingerprint)) return []
    seen.add(fingerprint)
    return [{
      key: `field-${field.index}`,
      control: field.tag as DetectedField["control"],
      inputType: field.type,
      label: field.label || field.placeholder || field.name || `Field ${field.index + 1}`,
      name: field.name,
      required: field.required,
      options: field.options,
      locator,
    }]
  })
}

async function detectActions(page: Page): Promise<DetectedAction[]> {
  const raw = await page.locator("button, input[type=submit], input[type=image]").evaluateAll((nodes) =>
    nodes.slice(0, 80).map((node, index) => {
      const element = node as HTMLButtonElement | HTMLInputElement
      const inputValue = element instanceof HTMLInputElement ? element.value : ""
      const inputAlt = element instanceof HTMLInputElement ? element.alt : ""
      const label = (element.getAttribute("aria-label") || inputValue || inputAlt || element.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200)
      return {
        index,
        tag: element.tagName.toLowerCase(),
        inputType: element.type.toLowerCase(),
        hasForm: Boolean(element.form),
        disabled: element.disabled,
        label,
      }
    })
  )
  return selectUnambiguousSubmitActions(raw)
}
