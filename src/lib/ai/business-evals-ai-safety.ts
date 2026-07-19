import type { AiJourneyDraftRequest } from "../api/business-evals-contracts"
import type { z } from "zod"

import type { aiJourneyDraftSuggestionResponseSchema } from "../api/business-evals-response-schemas"

const REDACTED = "[REDACTED]"
const BLOCKED_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "file",
  "hidden",
  "image",
  "radio",
  "reset",
  "submit",
  "tel",
])

export type AiJourneySuggestions = z.infer<typeof aiJourneyDraftSuggestionResponseSchema>

export function redactTextForAi(value: unknown, maximumLength: number) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, (match) => {
      const separator = match.includes(":") ? ":" : "="
      return `${match.slice(0, match.indexOf(separator)).trim()}${separator}${REDACTED}`
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\bMF-EVAL-[A-F0-9]{20}\b/gi, "[REDACTED_MARKER]")
    .replace(/https?:\/\/[^\s<>'\"]+/gi, (rawUrl) => redactUrl(rawUrl))
    .replace(/\b(?:\+?\d[\d .()-]{8,}\d)\b/g, "[REDACTED_PHONE]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return normalized.slice(0, maximumLength)
}

export function minimizeJourneyAssistanceInput(input: AiJourneyDraftRequest) {
  const target = new URL(input.startUrl)
  return {
    template: input.template,
    target: {
      origin: target.origin,
      pathname: redactTextForAi(target.pathname, 500) || "/",
    },
    objective: redactTextForAi(input.objective, 1_000),
    fields: input.fields.map((field) => ({
      key: field.key,
      control: field.control,
      inputType: redactTextForAi(field.inputType, 40).toLowerCase(),
      label: redactTextForAi(field.label, 200),
      name: redactTextForAi(field.name, 200),
      required: field.required,
      optionLabels: field.options
        .filter((option) => !option.disabled)
        .map((option) => redactTextForAi(option.label, 200))
        .filter(Boolean)
        .slice(0, 20),
      locator: minimizeLocator(field.locator),
      currentValueKey: field.currentValueKey,
      aiMappingAllowed: field.control !== "select" && !BLOCKED_INPUT_TYPES.has(field.inputType.toLowerCase()),
    })),
    actions: input.actions.map((action) => ({
      key: action.key,
      label: redactTextForAi(action.label, 200),
      role: action.role,
      locator: minimizeLocator(action.locator),
    })),
    stages: [...input.stages]
      .sort((left, right) => left.position - right.position)
      .map((stage) => ({
        key: stage.key,
        name: redactTextForAi(stage.name, 120),
        position: stage.position,
        expected: redactTextForAi(stage.expected, 1_000),
        businessImpact: redactTextForAi(stage.businessImpact, 1_000),
      })),
  }
}

export function minimizeRunDiagnosisInput(input: {
  run: Record<string, unknown>
  journeyStages?: Array<Record<string, unknown>>
}) {
  const stageDefinitions = new Map(
    (input.journeyStages ?? []).map((stage) => [String(stage.id ?? ""), stage])
  )
  const stages = Array.isArray(input.run.stages) ? input.run.stages : []
  const legacyEvidence = asRecord(input.run.legacyEndpointEvidence)
  return {
    source: String(input.run.source ?? "business_eval"),
    sourceVerdict: String(input.run.verdict ?? ""),
    trigger: redactTextForAi(input.run.trigger, 80),
    durationMs: finiteNumberOrNull(input.run.durationMs),
    summary: redactTextForAi(input.run.summary, 800),
    businessImpact: redactTextForAi(input.run.businessImpact, 800),
    cleanup: {
      status: redactTextForAi(input.run.cleanupStatus, 80),
      errorSummary: redactTextForAi(input.run.cleanupErrorSummary, 600),
    },
    stages: stages.map((rawStage, index) => {
      const stage = asRecord(rawStage) ?? {}
      const definition = stageDefinitions.get(String(stage.stage_definition_id ?? ""))
      return {
        stageKey: redactTextForAi(definition?.stage_key ?? `stage_${index + 1}`, 80),
        name: redactTextForAi(definition?.name ?? `Stage ${index + 1}`, 120),
        position: finiteNumberOrNull(stage.position),
        verdict: redactTextForAi(stage.verdict, 40),
        status: redactTextForAi(stage.status, 40),
        expected: redactTextForAi(stage.expected_text, 600),
        observed: redactTextForAi(stage.observed_text, 600),
        errorCode: redactTextForAi(stage.error_code, 120),
        durationMs: finiteNumberOrNull(stage.duration_ms),
        assertions: safeAssertionSummaries(stage.assertion_results_json),
        diagnosticSignals: safeDiagnosticSignals(stage.diagnostics_json),
      }
    }),
    legacyEndpointEvidence: legacyEvidence ? {
      evidenceOrigin: redactTextForAi(legacyEvidence.evidenceOrigin, 40),
      statusCode: finiteNumberOrNull(legacyEvidence.statusCode),
      latencyMs: finiteNumberOrNull(legacyEvidence.latencyMs),
      safeResponseSummary: redactTextForAi(legacyEvidence.safeResponseSummary, 600),
      errorMessage: redactTextForAi(legacyEvidence.errorMessage, 600),
      assertions: safeAssertionSummaries(legacyEvidence.assertionResults),
    } : null,
  }
}

export function assertJourneyAiSuggestionReferences(
  input: AiJourneyDraftRequest,
  suggestions: AiJourneySuggestions
) {
  const fieldByKey = new Map(input.fields.map((field) => [field.key, field]))
  const actionKeys = new Set(input.actions.map((action) => action.key))
  const stageKeys = new Set(input.stages.map((stage) => stage.key))
  const mappingKeys = new Set<string>()
  const locatorKeys = new Set<string>()
  const impactKeys = new Set<string>()

  for (const mapping of suggestions.fieldMappings) {
    const field = fieldByKey.get(mapping.fieldKey)
    if (!field) throw new Error("AI_FIELD_REFERENCE_INVALID")
    if (mappingKeys.has(mapping.fieldKey)) throw new Error("AI_FIELD_REFERENCE_DUPLICATE")
    if (field.control === "select" || BLOCKED_INPUT_TYPES.has(field.inputType.toLowerCase())) {
      throw new Error("AI_FIELD_MAPPING_UNSAFE")
    }
    if (field.inputType.toLowerCase() === "email" && mapping.valueKey !== "email") {
      throw new Error("AI_FIELD_MAPPING_UNSAFE")
    }
    if (field.inputType.toLowerCase() === "password" && mapping.valueKey !== "password") {
      throw new Error("AI_FIELD_MAPPING_UNSAFE")
    }
    if (field.inputType.toLowerCase() === "url" && mapping.valueKey !== "url") {
      throw new Error("AI_FIELD_MAPPING_UNSAFE")
    }
    if (field.inputType.toLowerCase() === "number" && mapping.valueKey !== "number") {
      throw new Error("AI_FIELD_MAPPING_UNSAFE")
    }
    mappingKeys.add(mapping.fieldKey)
  }

  for (const locator of suggestions.locators) {
    const allowed = locator.target === "field"
      ? fieldByKey.has(locator.targetKey)
      : actionKeys.has(locator.targetKey)
    if (!allowed) throw new Error("AI_LOCATOR_REFERENCE_INVALID")
    const key = `${locator.target}:${locator.targetKey}`
    if (locatorKeys.has(key)) throw new Error("AI_LOCATOR_REFERENCE_DUPLICATE")
    locatorKeys.add(key)
  }

  for (const impact of suggestions.businessImpacts) {
    if (!stageKeys.has(impact.stageKey)) throw new Error("AI_STAGE_REFERENCE_INVALID")
    if (impactKeys.has(impact.stageKey)) throw new Error("AI_STAGE_REFERENCE_DUPLICATE")
    impactKeys.add(impact.stageKey)
  }
}

function minimizeLocator(locator: AiJourneyDraftRequest["fields"][number]["locator"]) {
  if (!locator) return null
  if (locator.kind === "role") {
    return {
      kind: locator.kind,
      role: redactTextForAi(locator.role, 50),
      name: redactTextForAi(locator.name, 200),
    }
  }
  return { kind: locator.kind, value: redactTextForAi(locator.value, 200) }
}

function safeAssertionSummaries(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 30).map((item, index) => {
    const assertion = asRecord(item)
    if (!assertion) return { index, type: "unknown", result: "unknown", expected: "", observed: "", errorCode: "" }
    return {
      index,
      type: redactTextForAi(assertion.type ?? assertion.kind ?? assertion.assertionType, 80),
      result: redactTextForAi(assertion.result ?? assertion.verdict ?? assertion.status ?? assertion.passed, 40),
      expected: redactTextForAi(assertion.expected, 400),
      observed: redactTextForAi(assertion.observed, 400),
      errorCode: redactTextForAi(assertion.errorCode ?? assertion.error_code, 120),
    }
  })
}

function safeDiagnosticSignals(value: unknown) {
  const diagnostics = asRecord(value)
  if (!diagnostics) return {}
  const allowedKeys = [
    "code",
    "errorCode",
    "status",
    "phase",
    "locatorKind",
    "attemptCount",
    "timeoutMs",
    "captchaDetected",
    "ambiguousMatchCount",
  ]
  const entries: Array<[string, string | number | boolean]> = []
  for (const key of allowedKeys) {
    const raw = diagnostics[key]
    if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))) entries.push([key, raw])
    if (typeof raw === "string") entries.push([key, redactTextForAi(raw, 160)])
  }
  return Object.fromEntries(entries)
}

function redactUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ""
    parsed.password = ""
    parsed.search = parsed.search ? "?[REDACTED_QUERY]" : ""
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return REDACTED
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finiteNumberOrNull(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
