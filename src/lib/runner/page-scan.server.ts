import "server-only"

import Browserbase from "@browserbasehq/sdk"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

import { requireBrowserbaseExternalEgressProxy } from "@/lib/runner/browserbase-egress-config"
import { assertPublicBrowserTarget, installTopLevelNavigationGuard, pageContainsCaptcha, type BrowserNetworkMode } from "@/lib/runner/browser-safety.server"
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

export async function scanJourneyPage(url: string): Promise<JourneyPageScan> {
  const target = await assertPublicBrowserTarget(url, [new URL(url).hostname.toLowerCase()])
  const connection = await connectScanBrowser()
  try {
    await installTopLevelNavigationGuard(connection.page, [target.url.hostname], connection.networkMode)
    const response = await connection.page.goto(target.url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    })
    if (!response) throw new Error("The page did not return a navigation response.")

    const captchaDetected = await pageContainsCaptcha(connection.page)
    const fields = await detectFields(connection.page)
    const actions = await detectActions(connection.page)
    const warnings: string[] = []
    if (captchaDetected) warnings.push("A CAPTCHA was detected. This journey cannot be scheduled.")
    if (!fields.length) warnings.push("No supported form fields were detected on this page.")
    if (!actions.length) warnings.push("No unambiguous form submit control was detected.")

    return {
      url: connection.page.url(),
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

async function connectScanBrowser(): Promise<{
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
    const client = new Browserbase({ apiKey, maxRetries: 1, timeout: 30_000 })
    const externalEgressProxy = requireBrowserbaseExternalEgressProxy(process.env)
    const session = await client.sessions.create({
      ...(process.env.BROWSERBASE_PROJECT_ID?.trim() ? { projectId: process.env.BROWSERBASE_PROJECT_ID.trim() } : {}),
      timeout: 300,
      // No domainPattern means catch-all. Never add a direct, `none`, or
      // Browserbase-managed fallback to this production security boundary.
      proxies: [externalEgressProxy],
      region: "eu-central-1",
      browserSettings: {
        advancedStealth: false,
        solveCaptchas: false,
        recordSession: false,
        logSession: false,
        ignoreCertificateErrors: false,
      },
    }).catch(() => {
      throw new Error("Browserbase rejected the policy-constrained scan session configuration.")
    })
    const browser = await chromium.connectOverCDP(session.connectUrl).catch(() => {
      throw new Error("The Browserbase scan session connection failed securely.")
    })
    const context = browser.contexts()[0]
    const page = context?.pages()[0]
    if (!context || !page) throw new Error("Browserbase did not expose its default recorded context.")
    return {
      browser,
      context,
      page,
      networkMode: "external_proxy",
      close: async () => {
        await browser.close().catch(() => undefined)
      },
    }
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: false })
  const page = await context.newPage()
  return { browser, context, page, networkMode: "pinned_worker", close: () => browser.close() }
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
