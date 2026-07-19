import type { z } from "zod"

export type OpenAiUsageSummary = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export type StructuredOpenAiResult<T> =
  | {
      kind: "completed"
      data: T
      responseId: string
      model: string
      usage: OpenAiUsageSummary
    }
  | {
      kind: "refused"
      responseId: string
      model: string
      usage: OpenAiUsageSummary
    }
  | {
      kind: "invalid"
      code: "PROVIDER_ERROR" | "INCOMPLETE" | "MISSING_OUTPUT" | "INVALID_JSON" | "SCHEMA_MISMATCH"
      responseId: string
      model: string
      usage: OpenAiUsageSummary
    }

export function parseStructuredOpenAiResponse<TSchema extends z.ZodType>(
  payload: unknown,
  schema: TSchema
): StructuredOpenAiResult<z.infer<TSchema>> {
  const response = asRecord(payload)
  if (!response) return invalid("PROVIDER_ERROR", "", "", emptyUsage())
  const responseId = safeIdentifier(response.id)
  const model = safeIdentifier(response.model)
  const usage = parseUsage(response.usage)

  if (response.error) return invalid("PROVIDER_ERROR", responseId, model, usage)
  if (response.status !== "completed") return invalid("INCOMPLETE", responseId, model, usage)

  const output = Array.isArray(response.output) ? response.output : []
  const content = output.flatMap((item) => {
    const message = asRecord(item)
    return message?.type === "message" && Array.isArray(message.content) ? message.content : []
  })
  if (content.some((item) => asRecord(item)?.type === "refusal")) {
    return { kind: "refused", responseId, model, usage }
  }
  const text = content.flatMap((item) => {
    const part = asRecord(item)
    return part?.type === "output_text" && typeof part.text === "string" ? [part.text] : []
  }).join("")
  if (!text) return invalid("MISSING_OUTPUT", responseId, model, usage)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalid("INVALID_JSON", responseId, model, usage)
  }
  const validated = schema.safeParse(parsed)
  if (!validated.success) return invalid("SCHEMA_MISMATCH", responseId, model, usage)
  return { kind: "completed", data: validated.data, responseId, model, usage }
}

function invalid(
  code: Extract<StructuredOpenAiResult<never>, { kind: "invalid" }>["code"],
  responseId: string,
  model: string,
  usage: OpenAiUsageSummary
): StructuredOpenAiResult<never> {
  return { kind: "invalid", code, responseId, model, usage }
}

function parseUsage(value: unknown): OpenAiUsageSummary {
  const usage = asRecord(value)
  return {
    inputTokens: safeTokenCount(usage?.input_tokens),
    outputTokens: safeTokenCount(usage?.output_tokens),
    totalTokens: safeTokenCount(usage?.total_tokens),
  }
}

function safeTokenCount(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function safeIdentifier(value: unknown) {
  return typeof value === "string" ? value.slice(0, 200) : ""
}

function emptyUsage(): OpenAiUsageSummary {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
