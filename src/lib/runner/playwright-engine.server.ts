import "server-only"

import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Browser, BrowserContext, Locator, Page, Request, Response } from "playwright-core"

import type { LocatorDefinition, RestrictedAction } from "@/lib/api/business-evals-contracts"
import { isPlaywrightTimeoutError } from "@/lib/runner/assertion-truth"
import { createRunnerAssertionResult } from "@/lib/runner/assertion-results"
import {
  assertionTransitionViolation,
  urlMatchesPublishedPattern,
  type AssertionTransitionBaseline,
} from "@/lib/runner/assertion-transition"
import { assertNavigationStayedPublic, assertPublicBrowserTarget, installTopLevelNavigationGuard, pageContainsCaptcha, type BrowserNetworkMode } from "@/lib/runner/browser-safety.server"
import type {
  BrowserEvalStage,
  BrowserPhaseResult,
  BrowserSessionHandle,
  ExecuteBrowserPhaseInput,
  RunnerArtifact,
  RunnerStageResult,
} from "@/lib/runner/types"
import { ordinaryClickLooksDestructive } from "@/lib/runner/action-safety"

type ConnectedBrowser = {
  browser: Browser
  context: BrowserContext
  page: Page
  session: BrowserSessionHandle
  networkMode: BrowserNetworkMode
  resumeUrl?: string | null
  beforeDisconnect?: () => Promise<void>
}

type StageOutcome = {
  result: RunnerStageResult
  sideEffectCompletedAt: string | null
}

type SafeNetworkEntry = {
  event: "request" | "response" | "request_failed"
  method: string
  resourceType: string
  host: string
  pathDepth: number
  pathHash: string
  status?: number
  failure?: string
}

type PageObservationState = {
  mainDocumentStatus: number | null
  transitionAssertions: TransitionAssertionAction[]
  transitionBaselines: Map<TransitionAssertionAction, AssertionTransitionBaseline>
}

type TransitionAssertionAction = Extract<RestrictedAction, {
  type: "wait_for_url" | "wait_for_text" | "assert_visible"
}>

export async function executeWithConnectedBrowser(
  input: ExecuteBrowserPhaseInput,
  connected: ConnectedBrowser
): Promise<BrowserPhaseResult> {
  const { browser, page, session } = connected
  const stages: RunnerStageResult[] = []
  const artifacts: RunnerArtifact[] = []
  let captchaDetected = false
  let diagnosticStageId: string | null = null
  let sideEffectCompletedAt: string | null = null
  let activeStage: BrowserEvalStage | null = null
  let traceStarted = false
  const pageObservation: PageObservationState = {
    mainDocumentStatus: null,
    transitionAssertions: input.stages
      .flatMap((stage) => stage.actions)
      .filter(isTransitionAssertionAction),
    transitionBaselines: new Map(),
  }
  const safeNetworkEntries: SafeNetworkEntry[] = []
  const onRequest = (request: Request) => pushSafeNetworkEntry(safeNetworkEntries, request, "request")
  const onResponse = (response: Response) => {
    pushSafeNetworkEntry(safeNetworkEntries, response.request(), "response", response.status())
    if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) {
      pageObservation.mainDocumentStatus = response.status()
    }
  }
  const onRequestFailed = (request: Request) => pushSafeNetworkEntry(
    safeNetworkEntries,
    request,
    "request_failed",
    undefined,
    request.failure()?.errorText
  )

  await installTopLevelNavigationGuard(page, input.allowedHosts, connected.networkMode, {
    assertExecutionAllowed: input.assertExecutionAllowed,
    consumeDestination: input.consumeDestination,
  })
  if (connected.resumeUrl && page.url() === "about:blank") {
    await assertPublicBrowserTarget(connected.resumeUrl, input.allowedHosts)
    const response = await page.goto(connected.resumeUrl, { waitUntil: "domcontentloaded", timeout: 10_000 })
    if (response) pageObservation.mainDocumentStatus = response.status()
    await assertNavigationStayedPublic(page, input.allowedHosts)
  }
  page.on("request", onRequest)
  page.on("response", onResponse)
  page.on("requestfailed", onRequestFailed)
  traceStarted = await connected.context.tracing
    .start({ screenshots: true, snapshots: true, sources: false })
    .then(() => true)
    .catch(() => false)

  try {
    for (const stage of [...input.stages].sort((left, right) => left.position - right.position)) {
      activeStage = stage
      const outcome = await executeStage(
        page,
        stage,
        input.values,
        input.allowedHosts,
        pageObservation,
        input.assertExecutionAllowed
      )
      const result = outcome.result
      sideEffectCompletedAt = outcome.sideEffectCompletedAt ?? sideEffectCompletedAt
      stages.push(result)
      captchaDetected = captchaDetected || result.errorCode === "CAPTCHA_DETECTED"
      artifacts.push(await screenshotArtifact(
        page,
        stage,
        result.verdict !== "passed" && result.verdict !== "degraded",
        input.values
      ))
      if (["failed", "inconclusive"].includes(result.verdict)) diagnosticStageId = stage.id

      if (result.verdict === "failed" || result.verdict === "inconclusive" || result.verdict === "cancelled") {
        for (const remaining of input.stages.filter((candidate) => candidate.position > stage.position && !candidate.cleanup)) {
          stages.push(notRunResult(remaining, "An earlier required stage did not complete."))
        }
        break
      }
    }

    await assertNavigationStayedPublic(page, input.allowedHosts)
    return { session, stages, artifacts, currentUrl: safePageUrl(page.url()), captchaDetected, sideEffectCompletedAt }
  } catch (error) {
    const stage = activeStage ?? [...input.stages].sort((left, right) => left.position - right.position)[0]
    if (!stage) throw error
    const at = new Date().toISOString()
    const observed = redactDiagnosticText(error instanceof Error ? error.message : "The browser boundary stopped unexpectedly.", input.values)
    const failed: RunnerStageResult = {
      stageId: stage.id,
      verdict: "inconclusive",
      startedAt: at,
      completedAt: at,
      durationMs: 0,
      expected: stage.expected,
      observed,
      errorCode: "RUNNER_BOUNDARY_FAILED",
      diagnostics: { ...safePageLocation(page.url()), actionCount: stage.actions.length },
      assertionResults: [stageAssertion(stage, "inconclusive", observed, at)],
    }
    const existing = stages.findIndex((result) => result.stageId === stage.id)
    if (existing >= 0) stages[existing] = failed
    else stages.push(failed)
    diagnosticStageId = stage.id
    return { session, stages, artifacts, currentUrl: safePageUrl(page.url()), captchaDetected, sideEffectCompletedAt }
  } finally {
    page.off("request", onRequest)
    page.off("response", onResponse)
    page.off("requestfailed", onRequestFailed)
    if (diagnosticStageId) {
      artifacts.push(safeJsonArtifact("network_summary", diagnosticStageId, {
        schemaVersion: 1,
        entries: safeNetworkEntries,
        truncated: safeNetworkEntries.length >= 250,
      }))
      const domSummary = await createSanitizedDomSummary(page).catch(() => null)
      if (domSummary) artifacts.push(safeJsonArtifact("dom_summary", diagnosticStageId, domSummary))
    }
    const retainedTraceStageId = diagnosticStageId
    if (retainedTraceStageId && traceStarted) {
      const trace = await stopPlaywrightTraceArtifact(connected.context, retainedTraceStageId).catch(() => null)
      if (trace) artifacts.push(trace)
      traceStarted = false
    }
    if (traceStarted) await connected.context.tracing.stop().catch(() => undefined)
    await connected.beforeDisconnect?.().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

async function executeStage(
  page: Page,
  stage: BrowserEvalStage,
  values: Record<string, string>,
  allowedHosts: string[],
  pageObservation: PageObservationState,
  assertExecutionAllowed?: () => Promise<void>
): Promise<StageOutcome> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  let sideEffectCompletedAt: string | null = null

  try {
    for (const action of stage.actions) {
      if (await pageContainsCaptcha(page)) {
        throw new StageExecutionError("CAPTCHA_DETECTED", "A CAPTCHA or human verification challenge prevented trustworthy execution.", "inconclusive")
      }
      if (await pageContainsExcludedPaymentSurface(page)) {
        throw new StageExecutionError("PAYMENT_FLOW_EXCLUDED", "A payment or checkout surface is outside the supported business-eval templates.", "inconclusive")
      }
      sideEffectCompletedAt = await executeAction(
        page,
        action,
        values,
        allowedHosts,
        pageObservation,
        assertExecutionAllowed
      ) ?? sideEffectCompletedAt
    }

    if (await pageContainsCaptcha(page)) {
      throw new StageExecutionError("CAPTCHA_DETECTED", "A CAPTCHA or human verification challenge prevented trustworthy execution.", "inconclusive")
    }
    if (await pageContainsExcludedPaymentSurface(page)) {
      throw new StageExecutionError("PAYMENT_FLOW_EXCLUDED", "A payment or checkout surface is outside the supported business-eval templates.", "inconclusive")
    }

    const completed = Date.now()
    const degraded = Boolean(stage.timingThresholdMs && completed - started > stage.timingThresholdMs)
    const verdict = degraded ? "degraded" as const : "passed" as const
    const completedAt = new Date(completed).toISOString()
    const observed = degraded
      ? `The stage completed in ${completed - started} ms, above its approved threshold.`
      : `The stage completed deterministically in ${completed - started} ms.`
    return {
      result: {
        stageId: stage.id,
        verdict,
        startedAt,
        completedAt,
        durationMs: completed - started,
        expected: stage.expected,
        observed,
        errorCode: null,
        diagnostics: { ...safePageLocation(page.url()), actionCount: stage.actions.length },
        assertionResults: [stageAssertion(stage, verdict, observed, completedAt)],
      },
      sideEffectCompletedAt,
    }
  } catch (error) {
    const completed = Date.now()
    const known = error instanceof StageExecutionError
      ? error
      : new StageExecutionError("RUNNER_ERROR", error instanceof Error ? error.message : "The browser runner stopped unexpectedly.", "inconclusive")
    const completedAt = new Date(completed).toISOString()
    const observed = redactDiagnosticText(known.message, values)
    return {
      result: {
        stageId: stage.id,
        verdict: known.verdict,
        startedAt,
        completedAt,
        durationMs: completed - started,
        expected: stage.expected,
        observed,
        errorCode: known.code,
        diagnostics: { ...safePageLocation(page.url()), actionCount: stage.actions.length },
        assertionResults: [stageAssertion(stage, known.verdict, observed, completedAt)],
      },
      sideEffectCompletedAt,
    }
  }
}

async function pageContainsExcludedPaymentSurface(page: Page) {
  const host = new URL(page.url()).hostname.toLowerCase()
  if (["checkout.stripe.com", "www.paypal.com", "checkout.square.site"].includes(host)) return true
  const selectors = [
    "input[autocomplete^='cc-']",
    "input[name*='card-number' i]",
    "input[name*='cardnumber' i]",
    "iframe[src*='checkout.stripe.com']",
    "iframe[src*='js.stripe.com'][title*='payment' i]",
    "iframe[src*='paypal.com'][title*='payment' i]",
  ]
  for (const selector of selectors) {
    if (await page.locator(selector).count()) return true
  }
  return false
}

async function executeAction(
  page: Page,
  action: RestrictedAction,
  values: Record<string, string>,
  allowedHosts: string[],
  pageObservation: PageObservationState,
  assertExecutionAllowed?: () => Promise<void>
) {
  const timeout = action.timeoutMs
  switch (action.type) {
    case "navigate": {
      await assertPublicBrowserTarget(action.url, allowedHosts)
      await captureTransitionBaselines(page, pageObservation, action.id)
      await assertExecutionAllowed?.()
      const response = await page.goto(action.url, { waitUntil: "domcontentloaded", timeout })
      if (!response) throw new StageExecutionError("NAVIGATION_FAILED", "The page did not return a navigation response.", "inconclusive")
      pageObservation.mainDocumentStatus = response.status()
      await assertNavigationStayedPublic(page, allowedHosts)
      return
    }
    case "fill": {
      const locator = await uniqueLocator(page, action.locator, timeout)
      if (action.operation === "select") {
        const selected = await locator.selectOption({ value: action.optionValue }, { timeout })
        if (selected.length !== 1 || selected[0] !== action.optionValue) {
          throw new StageExecutionError("SELECT_OPTION_NOT_APPLIED", "The published select option could not be applied deterministically.", "inconclusive")
        }
        return
      }
      if (action.operation === "check") {
        await assertPublishedCheckControl(locator, action)
        await locator.check({ timeout })
        if (!await locator.isChecked()) {
          throw new StageExecutionError("CHECK_STATE_NOT_APPLIED", "The published checkbox or radio state could not be applied deterministically.", "inconclusive")
        }
        return
      }
      const value = values[action.valueKey]
      if (value === undefined) throw new StageExecutionError("VALUE_MISSING", `Synthetic value ${action.valueKey} was not supplied.`, "inconclusive")
      await locator.fill(value, { timeout })
      return
    }
    case "click": {
      if (ordinaryClickLooksDestructive(action)) {
        throw new StageExecutionError(
          "DESTRUCTIVE_ACTION_EXCLUDED",
          "A destructive or payment-like ordinary click is outside the approved business-eval manifest. Use the explicit cleanup action for deterministic account cleanup.",
          "inconclusive"
        )
      }
      const locator = await uniqueLocator(page, action.locator, timeout)
      await assertFormSubmitControl(locator)
      await captureTransitionBaselines(page, pageObservation, action.id)
      await assertExecutionAllowed?.()
      await locator.click({ timeout })
      const completedAt = new Date().toISOString()
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 5_000) }).catch(() => undefined)
      await assertNavigationStayedPublic(page, allowedHosts)
      return completedAt
    }
    case "wait_for_url":
      requirePostActionTransition(pageObservation, action)
      try {
        await page.waitForURL(action.urlPattern, { timeout })
      } catch (error) {
        await failDeterministicAssertionTimeout({
          page,
          allowedHosts,
          error,
          pageObservation,
          code: "URL_ASSERTION_NOT_MET",
          message: `${action.label} did not match within its configured threshold.`,
        })
      }
      await assertNavigationStayedPublic(page, allowedHosts)
      return
    case "wait_for_text":
      requirePostActionTransition(pageObservation, action)
      await waitForUniqueVisibleAssertion(
        page,
        { kind: "text", value: action.text, exact: false },
        timeout,
        allowedHosts,
        pageObservation,
        action.label
      )
      return
    case "assert_visible": {
      requirePostActionTransition(pageObservation, action)
      await waitForUniqueVisibleAssertion(page, action.locator, timeout, allowedHosts, pageObservation, action.label)
      return
    }
    case "open_email_link":
      throw new StageExecutionError("EMAIL_LINK_REQUIRED", "The verified email link must be supplied by the durable email stage.", "inconclusive")
    case "wait_for_email":
      throw new StageExecutionError("EMAIL_WAIT_REQUIRED", "Email waits are handled by the durable workflow hook.", "inconclusive")
    case "cleanup": {
      if (action.mode === "webhook") {
        throw new StageExecutionError("CLEANUP_WEBHOOK_REQUIRED", "Customer-owned cleanup webhooks run outside the browser phase.", "inconclusive")
      }
      if (!action.locator) throw new StageExecutionError("CLEANUP_LOCATOR_MISSING", "The cleanup control is not configured.", "inconclusive")
      const locator = await uniqueLocator(page, action.locator, timeout)
      await captureTransitionBaselines(page, pageObservation, action.id)
      await assertExecutionAllowed?.()
      await locator.click({ timeout })
      return
    }
  }
}

async function assertPublishedCheckControl(
  locator: Locator,
  action: Extract<RestrictedAction, { type: "fill"; operation: "check" }>
) {
  const identity = await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    type: element instanceof HTMLInputElement ? element.type.toLowerCase() : "",
    name: element instanceof HTMLInputElement ? element.name : "",
  }))
  if (identity.tag !== "input" || identity.type !== action.controlKind) {
    throw new StageExecutionError(
      "CHECK_CONTROL_MISMATCH",
      "The published consent-control kind no longer matches the unique semantic target.",
      "inconclusive"
    )
  }
  if (action.controlKind === "radio" && identity.name !== action.radioGroup) {
    throw new StageExecutionError(
      "RADIO_GROUP_MISMATCH",
      "The published semantic radio group no longer matches the target page.",
      "inconclusive"
    )
  }
}

function isTransitionAssertionAction(action: RestrictedAction): action is TransitionAssertionAction {
  return action.type === "wait_for_url" || action.type === "wait_for_text" || action.type === "assert_visible"
}

async function captureTransitionBaselines(
  page: Page,
  pageObservation: PageObservationState,
  sourceActionId: string
) {
  const capturedAt = new Date().toISOString()
  await Promise.all(pageObservation.transitionAssertions.map(async (assertion) => {
    let satisfiedBeforeAction: boolean | null = null
    try {
      satisfiedBeforeAction = await transitionAssertionIsSatisfied(page, assertion)
    } catch {
      satisfiedBeforeAction = null
    }
    pageObservation.transitionBaselines.set(assertion, {
      satisfiedBeforeAction,
      sourceActionId,
      capturedAt,
    })
  }))
}

async function transitionAssertionIsSatisfied(page: Page, action: TransitionAssertionAction) {
  if (action.type === "wait_for_url") return urlMatchesPublishedPattern(page.url(), action.urlPattern)
  const definition: LocatorDefinition = action.type === "wait_for_text"
    ? { kind: "text", value: action.text, exact: false }
    : action.locator
  const locator = locatorFromDefinition(page, definition)
  if (await locator.count() !== 1) return false
  return locator.isVisible()
}

function requirePostActionTransition(pageObservation: PageObservationState, action: TransitionAssertionAction) {
  const violation = assertionTransitionViolation(pageObservation.transitionBaselines.get(action))
  if (violation) throw new StageExecutionError(violation.code, violation.message, "inconclusive")
}

async function assertFormSubmitControl(locator: Locator) {
  const isSubmitControl = await locator.evaluate((element) => {
    if (element instanceof HTMLButtonElement) return Boolean(element.form) && element.type === "submit" && !element.disabled
    if (element instanceof HTMLInputElement) {
      return Boolean(element.form) && ["submit", "image"].includes(element.type) && !element.disabled
    }
    return false
  }).catch(() => false)
  if (!isSubmitControl) {
    throw new StageExecutionError(
      "SUBMIT_CONTROL_REQUIRED",
      "The approved submit locator must resolve to an enabled form-associated submit control.",
      "inconclusive"
    )
  }
}

async function waitForUniqueVisibleAssertion(
  page: Page,
  definition: LocatorDefinition,
  timeout: number,
  allowedHosts: string[],
  pageObservation: PageObservationState,
  label: string
) {
  const locator = locatorFromDefinition(page, definition)
  try {
    await locator.first().waitFor({ state: "visible", timeout })
  } catch (error) {
    await failDeterministicAssertionTimeout({
      page,
      allowedHosts,
      error,
      pageObservation,
      code: "VISIBLE_ASSERTION_NOT_MET",
      message: `${label} was not visible within its configured threshold.`,
    })
  }

  const count = await locator.count()
  if (count !== 1) {
    throw new StageExecutionError(
      "AMBIGUOUS_LOCATOR",
      count === 0 ? "The approved assertion element could not be found." : `The approved assertion locator matched ${count} elements.`,
      count === 0 ? "failed" : "inconclusive"
    )
  }
}

async function failDeterministicAssertionTimeout(input: {
  page: Page
  allowedHosts: string[]
  error: unknown
  pageObservation: PageObservationState
  code: string
  message: string
}): Promise<never> {
  if (!isPlaywrightTimeoutError(input.error) || input.page.isClosed()) throw input.error
  await assertNavigationStayedPublic(input.page, input.allowedHosts)
  if (input.pageObservation.mainDocumentStatus && [401, 403, 407, 429, 451].includes(input.pageObservation.mainDocumentStatus)) {
    throw new StageExecutionError(
      "ACCESS_BLOCKED",
      `HTTP ${input.pageObservation.mainDocumentStatus} prevented a trustworthy business assertion.`,
      "inconclusive"
    )
  }
  if (await pageContainsCaptcha(input.page)) {
    throw new StageExecutionError(
      "CAPTCHA_DETECTED",
      "A CAPTCHA or human verification challenge prevented trustworthy execution.",
      "inconclusive"
    )
  }
  if (await pageContainsExcludedPaymentSurface(input.page)) {
    throw new StageExecutionError(
      "PAYMENT_FLOW_EXCLUDED",
      "A payment or checkout surface is outside the supported business-eval templates.",
      "inconclusive"
    )
  }
  throw new StageExecutionError(input.code, input.message, "failed")
}

function pushSafeNetworkEntry(
  entries: SafeNetworkEntry[],
  request: Request,
  event: SafeNetworkEntry["event"],
  status?: number,
  failure?: string
) {
  if (entries.length >= 250) return
  let parsed: URL
  try {
    parsed = new URL(request.url())
  } catch {
    return
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return
  const path = parsed.pathname || "/"
  entries.push({
    event,
    method: request.method().slice(0, 16),
    resourceType: request.resourceType().slice(0, 32),
    host: parsed.hostname.toLowerCase().slice(0, 253),
    pathDepth: path === "/" ? 0 : path.split("/").filter(Boolean).length,
    pathHash: createHash("sha256").update(path).digest("hex"),
    ...(status === undefined ? {} : { status }),
    ...(failure ? { failure: failure.replaceAll(/https?:\/\/[^\s]+/gi, "[redacted-url]").slice(0, 120) } : {}),
  })
}

async function createSanitizedDomSummary(page: Page) {
  const summary = await page.evaluate(() => {
    const count = (selector: string) => document.querySelectorAll(selector).length
    const inputTypes: Record<string, number> = {}
    for (const element of document.querySelectorAll("input")) {
      const rawType = (element.getAttribute("type") || "text").toLowerCase()
      const type = ["text", "email", "password", "tel", "url", "number", "checkbox", "radio", "hidden", "submit"].includes(rawType)
        ? rawType
        : "other"
      inputTypes[type] = (inputTypes[type] ?? 0) + 1
    }
    return {
      schemaVersion: 1,
      readyState: document.readyState,
      forms: count("form"),
      inputs: count("input"),
      textareas: count("textarea"),
      selects: count("select"),
      buttons: count("button,[role='button']"),
      links: count("a[href]"),
      dialogs: count("dialog,[role='dialog'],[role='alertdialog']"),
      alerts: count("[role='alert']"),
      frames: count("iframe"),
      inputTypes,
    }
  })
  return { ...summary, location: safePageLocation(page.url()) }
}

function safeJsonArtifact(kind: "dom_summary" | "network_summary", stageId: string, value: unknown): RunnerArtifact {
  return {
    kind,
    stageId,
    contentType: "application/json",
    dataBase64: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
    reportSafe: false,
    redacted: true,
  }
}

async function stopPlaywrightTraceArtifact(context: BrowserContext, stageId: string): Promise<RunnerArtifact | null> {
  const directory = await mkdtemp(join(tmpdir(), "maintainflow-trace-"))
  const path = join(directory, "trace.zip")
  try {
    await context.tracing.stop({ path })
    const trace = await readFile(path)
    if (!trace.byteLength || trace.byteLength > 50 * 1024 * 1024) return null
    return {
      kind: "trace",
      stageId,
      contentType: "application/zip",
      dataBase64: trace.toString("base64"),
      reportSafe: false,
      // Playwright traces contain private page and network diagnosis. They are
      // never exposed through report links and are not claimed as redacted.
      redacted: false,
    }
  } finally {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined)
  }
}

function safePageLocation(value: string) {
  try {
    const url = new URL(value)
    const path = url.pathname || "/"
    return {
      origin: url.origin,
      pathDepth: path === "/" ? 0 : path.split("/").filter(Boolean).length,
      pathHash: createHash("sha256").update(path).digest("hex"),
    }
  } catch {
    return { origin: "", pathDepth: 0, pathHash: "" }
  }
}

function safePageUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return "about:blank"
  }
}

function redactDiagnosticText(message: string, values: Record<string, string>) {
  let safe = message.replaceAll(/https?:\/\/[^\s]+/gi, "[redacted-url]")
  for (const value of new Set(Object.values(values).map((item) => item.trim()).filter((item) => item.length >= 3))) {
    safe = safe.replaceAll(value, "[redacted-synthetic]")
  }
  return safe.slice(0, 1_000)
}

async function uniqueLocator(page: Page, definition: LocatorDefinition, timeout: number) {
  const locator = locatorFromDefinition(page, definition)
  await locator.first().waitFor({ state: "attached", timeout })
  const count = await locator.count()
  if (count !== 1) {
    throw new StageExecutionError(
      "AMBIGUOUS_LOCATOR",
      count === 0 ? "The approved element could not be found." : `The approved locator matched ${count} elements.`,
      "inconclusive"
    )
  }
  return locator as Locator
}

function locatorFromDefinition(page: Page, definition: LocatorDefinition) {
  switch (definition.kind) {
    case "role":
      return page.getByRole(definition.role as never, { name: definition.name, exact: true })
    case "label":
      return page.getByLabel(definition.value, { exact: true })
    case "placeholder":
      return page.getByPlaceholder(definition.value, { exact: true })
    case "text":
      return page.getByText(definition.value, { exact: definition.exact })
    case "test_id":
      return page.getByTestId(definition.value)
  }
}

async function screenshotArtifact(
  page: Page,
  stage: BrowserEvalStage,
  diagnostic: boolean,
  syntheticValues: Record<string, string>
): Promise<RunnerArtifact> {
  const redactionAttribute = "data-mf-screenshot-redact"
  await markScreenshotRedactionTargets(page, redactionAttribute)
  const masks = [
    page.locator(`[${redactionAttribute}]`),
    page.locator("input, textarea, select, option, [contenteditable], [data-sensitive='true']"),
  ]
  for (const action of stage.actions) {
    if ("locator" in action && action.locator) masks.push(locatorFromDefinition(page, action.locator))
    if (action.type === "wait_for_text") masks.push(page.getByText(action.text, { exact: false }))
  }
  for (const value of new Set(Object.values(syntheticValues).map((item) => item.trim()).filter((item) => item.length >= 3))) {
    masks.push(page.getByText(value, { exact: false }))
  }
  try {
    const screenshot = await page.screenshot({
      type: "jpeg",
      quality: 70,
      fullPage: false,
      mask: masks,
      maskColor: "#E5E7EB",
      // Playwright applies screenshot styles through shadow roots and frames.
      // Hiding every textual/media/background channel makes the report-safe
      // claim independent of customer markup or a forgotten field selector.
      style: REPORT_SAFE_SCREENSHOT_STYLE,
    })
    return {
      kind: "screenshot",
      stageId: stage.id,
      contentType: "image/jpeg",
      dataBase64: screenshot.toString("base64"),
      reportSafe: !diagnostic,
      redacted: true,
    }
  } finally {
    await clearScreenshotRedactionTargets(page, redactionAttribute).catch(() => undefined)
  }
}

const REPORT_SAFE_SCREENSHOT_STYLE = `
  html *, html *::before, html *::after {
    color: transparent !important;
    -webkit-text-fill-color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
    background-image: none !important;
    border-image: none !important;
    list-style-image: none !important;
  }
  html *::before, html *::after { content: "" !important; }
  html img, html picture, html video, html audio, html canvas, html svg,
  html iframe, html object, html embed, html [role="img"] {
    visibility: hidden !important;
  }
`

async function markScreenshotRedactionTargets(page: Page, attribute: string) {
  await page.evaluate((redactionAttribute) => {
    const visit = (root: Document | ShadowRoot) => {
      for (const element of root.querySelectorAll<HTMLElement>("*")) {
        const tag = element.tagName.toLowerCase()
        const directText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))
        const media = ["img", "picture", "video", "audio", "canvas", "svg", "iframe", "object", "embed"].includes(tag)
        const formValue = element instanceof HTMLInputElement
          || element instanceof HTMLTextAreaElement
          || element instanceof HTMLSelectElement
          || element.isContentEditable
        const customElement = tag.includes("-")
        if (directText || media || formValue || customElement || element.dataset.sensitive === "true") {
          element.setAttribute(redactionAttribute, "true")
        }
        if (element.shadowRoot) visit(element.shadowRoot)
      }
    }
    visit(document)
  }, attribute)
}

async function clearScreenshotRedactionTargets(page: Page, attribute: string) {
  await page.evaluate((redactionAttribute) => {
    const visit = (root: Document | ShadowRoot) => {
      for (const element of root.querySelectorAll<HTMLElement>(`[${redactionAttribute}]`)) {
        element.removeAttribute(redactionAttribute)
        if (element.shadowRoot) visit(element.shadowRoot)
      }
    }
    visit(document)
  }, attribute)
}

function notRunResult(stage: BrowserEvalStage, observed: string): RunnerStageResult {
  const at = new Date().toISOString()
  return {
    stageId: stage.id,
    verdict: "not_run",
    startedAt: at,
    completedAt: at,
    durationMs: 0,
    expected: stage.expected,
    observed,
    errorCode: null,
    diagnostics: {},
    assertionResults: [stageAssertion(stage, "not_run", observed, at)],
  }
}

function stageAssertion(
  stage: BrowserEvalStage,
  result: RunnerStageResult["verdict"],
  safeObservation: string,
  evaluatedAt: string
) {
  return createRunnerAssertionResult({
    assertionId: `stage:${stage.id}`,
    required: stage.required,
    expectedRule: stage.expected,
    safeObservation,
    result,
    evaluatedAt,
  })
}

class StageExecutionError extends Error {
  code: string
  verdict: "failed" | "inconclusive"

  constructor(code: string, message: string, verdict: "failed" | "inconclusive") {
    super(message)
    this.name = "StageExecutionError"
    this.code = code
    this.verdict = verdict
  }
}
