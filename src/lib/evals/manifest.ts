import type { ActionManifest, JourneyAction, LocatorDefinition } from "./types.ts"

const actionTypes = new Set<JourneyAction["type"]>([
  "navigate",
  "fill",
  "click",
  "wait_for_url",
  "wait_for_text",
  "wait_for_email",
  "open_email_link",
  "assert_visible",
  "cleanup",
])
const forbiddenKeys = /^(?:css|selector|xpath|javascript|script|code|evaluate)$/i
const safeSyntheticValueKeys = new Set([
  "marker", "first_name", "last_name", "full_name", "name", "email",
  "company", "workspace", "message", "password", "number", "url",
])

export function validateActionManifest(input: unknown): ActionManifest {
  assertNoForbiddenExecutionKeys(input)
  if (!isRecord(input) || !Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 30) {
    throw new Error("An action manifest requires between 1 and 30 restricted actions.")
  }
  const actions = input.actions.map(validateAction)
  const selectedRadioGroups = new Set<string>()
  for (const action of actions) {
    if (action.type !== "fill" || action.operation !== "check" || action.controlKind !== "radio") continue
    if (selectedRadioGroups.has(action.radioGroup)) {
      throw new Error("An action manifest may select only one option per semantic radio group.")
    }
    selectedRadioGroups.add(action.radioGroup)
  }
  return { actions }
}

function validateAction(input: unknown): JourneyAction {
  if (!isRecord(input) || typeof input.type !== "string" || !actionTypes.has(input.type as JourneyAction["type"])) {
    throw new Error("Unsupported journey action.")
  }
  const base = {
    id: boundedString(input.id, 80, "Actions require a stable identifier."),
    label: boundedString(input.label, 120, "Actions require a business-readable label."),
    timeoutMs: requiredTimeout(input.timeoutMs),
  }

  switch (input.type) {
    case "navigate":
      assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "url"])
      return { ...base, type: "navigate", url: httpsUrl(input.url) }
    case "fill":
      if (input.operation === undefined || input.operation === "text") {
        assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "operation", "locator", "valueKey"])
        const valueKey = boundedString(input.valueKey, 80, "Text fill actions require a synthetic value key.")
        if (!safeSyntheticValueKeys.has(valueKey)) throw new Error("Text fill actions require an approved non-contactable synthetic value key.")
        return {
          ...base,
          type: "fill",
          operation: "text",
          locator: validateLocator(input.locator),
          valueKey,
        }
      }
      if (input.operation === "select") {
        assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "operation", "locator", "optionValue"])
        return {
          ...base,
          type: "fill",
          operation: "select",
          locator: validateLocator(input.locator),
          optionValue: boundedStringAllowEmpty(input.optionValue, 500, "Select actions require a published option value."),
        }
      }
      if (input.operation === "check") {
        const controlKind = input.controlKind
        const allowedKeys = controlKind === "radio"
          ? ["id", "label", "timeoutMs", "type", "operation", "locator", "expectedChecked", "operatorApproved", "controlKind", "radioGroup"]
          : ["id", "label", "timeoutMs", "type", "operation", "locator", "expectedChecked", "operatorApproved", "controlKind"]
        assertOnlyKeys(input, allowedKeys)
        if (input.expectedChecked !== true) throw new Error("Checkbox and radio actions may only publish an explicit checked state.")
        if (input.operatorApproved !== true) throw new Error("Checkbox and radio actions require explicit operator approval.")
        if (controlKind !== "checkbox" && controlKind !== "radio") throw new Error("Checked controls require an explicit checkbox or radio kind.")
        const common = {
          ...base,
          type: "fill" as const,
          operation: "check" as const,
          locator: validateLocator(input.locator),
          expectedChecked: true as const,
          operatorApproved: true as const,
        }
        if (controlKind === "radio") {
          return {
            ...common,
            controlKind,
            radioGroup: boundedString(input.radioGroup, 200, "Radio actions require one semantic group name."),
          }
        }
        return { ...common, controlKind }
      }
      throw new Error("Fill actions support only text, select, or check operations.")
    case "click":
    case "assert_visible":
      assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "locator"])
      return { ...base, type: input.type, locator: validateLocator(input.locator) }
    case "wait_for_url":
      assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "urlPattern"])
      return {
        ...base,
        type: "wait_for_url",
        urlPattern: boundedString(input.urlPattern, 500, "URL waits require a bounded URL pattern."),
      }
    case "wait_for_text":
      assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "text"])
      return {
        ...base,
        type: "wait_for_text",
        text: boundedString(input.text, 500, "Text waits require bounded expected text."),
    }
    case "wait_for_email": {
      assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "recipientKey", "proofMode", "thresholdSeconds", "maximumWaitSeconds"])
      const thresholdSeconds = Number(input.thresholdSeconds)
      if (!Number.isInteger(thresholdSeconds) || thresholdSeconds < 5 || thresholdSeconds > 3_600) {
        throw new Error("Email waits require a threshold between 5 and 3600 seconds.")
      }
      const maximumWaitSeconds = input.maximumWaitSeconds === undefined ? 600 : Number(input.maximumWaitSeconds)
      if (!Number.isInteger(maximumWaitSeconds) || maximumWaitSeconds < thresholdSeconds || maximumWaitSeconds > 3_600) {
        throw new Error("Email waits require a final maximum wait between the degraded threshold and 3600 seconds.")
      }
      const proofMode = input.proofMode === undefined ? "autoresponse" : input.proofMode
      if (proofMode !== "autoresponse" && proofMode !== "forwarded_marker") {
        throw new Error("Email waits require an approved proof mode.")
      }
      const recipientKey = boundedString(input.recipientKey, 80, "Email waits require a synthetic recipient key.")
      if (recipientKey !== "email" && recipientKey !== "forwarding") {
        throw new Error("Email waits require an approved recipient route.")
      }
      if (
        (proofMode === "autoresponse" && recipientKey !== "email")
        || (proofMode === "forwarded_marker" && recipientKey !== "forwarding")
      ) {
        throw new Error("Email proof routing must match its configured proof mode.")
      }
      return {
        ...base,
        type: "wait_for_email",
        recipientKey,
        proofMode,
        thresholdSeconds,
        maximumWaitSeconds,
      }
    }
    case "open_email_link": {
      assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "allowedHosts", "linkRule"])
      if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length === 0 || input.allowedHosts.length > 20) {
        throw new Error("Email-link actions require between 1 and 20 approved hosts.")
      }
      const allowedHosts = [...new Set(input.allowedHosts.map(publicHostname))]
      const linkRule = validateVerificationLinkRule(input.linkRule)
      if (!allowedHosts.some((host) => linkRule.host === host || linkRule.host.endsWith(`.${host}`))) {
        throw new Error("The verification-link rule host must be covered by its published host allowlist.")
      }
      return { ...base, type: "open_email_link", allowedHosts, linkRule }
    }
    case "cleanup":
      if (input.mode === "in_product") {
        assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "mode", "locator"])
        return { ...base, type: "cleanup", mode: "in_product", locator: validateLocator(input.locator) }
      }
      if (input.mode === "webhook") {
        assertOnlyKeys(input, ["id", "label", "timeoutMs", "type", "mode", "webhookUrl"])
        return { ...base, type: "cleanup", mode: "webhook", webhookUrl: httpsUrl(input.webhookUrl) }
      }
      throw new Error("Cleanup actions must use in_product or webhook mode.")
    default:
      throw new Error("Unsupported journey action.")
  }
}

function validateLocator(input: unknown): LocatorDefinition {
  if (!isRecord(input) || typeof input.kind !== "string") throw new Error("A semantic locator is required.")
  switch (input.kind) {
    case "role":
      assertOnlyKeys(input, ["kind", "role", "name"])
      return {
        kind: "role",
        role: boundedString(input.role, 50, "Role locator is invalid."),
        name: boundedString(input.name, 200, "Role locator is invalid."),
      }
    case "label":
    case "placeholder":
    case "test_id":
      assertOnlyKeys(input, ["kind", "value"])
      return { kind: input.kind, value: boundedString(input.value, 200, "Semantic locator is invalid.") }
    case "text":
      assertOnlyKeys(input, ["kind", "value", "exact"])
      if (input.exact !== undefined && typeof input.exact !== "boolean") throw new Error("Text locator is invalid.")
      return {
        kind: "text",
        value: boundedString(input.value, 200, "Text locator is invalid."),
        ...(input.exact === undefined ? {} : { exact: input.exact }),
      }
    default:
      throw new Error("Only role, label, placeholder, text, and test-id locators are allowed.")
  }
}

function validateVerificationLinkRule(input: unknown) {
  if (!isRecord(input)) throw new Error("Email-link actions require a published matching rule.")
  assertOnlyKeys(input, ["host", "pathPrefix", "requiredText", "requiredQueryParameter"])
  const host = publicHostname(input.host)
  const pathPrefix = boundedString(input.pathPrefix, 500, "Verification-link rules require a path prefix.")
  if (!pathPrefix.startsWith("/") || /[?#]/.test(pathPrefix)) {
    throw new Error("Verification-link path prefixes must start with / and exclude query strings or fragments.")
  }
  const requiredText = input.requiredText === undefined ? undefined : boundedString(input.requiredText, 200, "Verification-link text is invalid.")
  const requiredQueryParameter = input.requiredQueryParameter === undefined
    ? undefined
    : boundedString(input.requiredQueryParameter, 100, "Verification-link query property is invalid.")
  if (requiredQueryParameter && !/^[A-Za-z0-9_.~-]+$/.test(requiredQueryParameter)) {
    throw new Error("Verification-link query properties must be parameter names, not values.")
  }
  return {
    host,
    pathPrefix,
    ...(requiredText ? { requiredText } : {}),
    ...(requiredQueryParameter ? { requiredQueryParameter } : {}),
  }
}

function assertNoForbiddenExecutionKeys(input: unknown): void {
  if (Array.isArray(input)) {
    input.forEach(assertNoForbiddenExecutionKeys)
    return
  }
  if (!isRecord(input)) return
  for (const [key, value] of Object.entries(input)) {
    if (forbiddenKeys.test(key)) throw new Error("Arbitrary JavaScript, CSS selectors, and XPath are not allowed.")
    assertNoForbiddenExecutionKeys(value)
  }
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[]) {
  const allowlist = new Set(allowed)
  if (Object.keys(input).some((key) => !allowlist.has(key))) {
    throw new Error("Restricted actions and locators cannot contain unapproved fields.")
  }
}

function httpsUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("Navigation requires a public HTTPS URL.")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Navigation requires a public HTTPS URL.")
  publicHostname(url.hostname)
  return url.toString()
}

function publicHostname(value: unknown) {
  if (typeof value !== "string") throw new Error("A public hostname is required.")
  const hostname = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
  if (
    hostname.length > 253
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
  ) {
    throw new Error("A public hostname is required.")
  }
  return hostname
}

function requiredTimeout(value: unknown) {
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < 250 || timeout > 60_000) {
    throw new Error("Action timeout is outside the allowed range.")
  }
  return timeout
}

function boundedString(value: unknown, maxLength: number, message: string) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error(message)
  return value.trim()
}

function boundedStringAllowEmpty(value: unknown, maxLength: number, message: string) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(message)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
