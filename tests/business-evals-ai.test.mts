import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  aiJourneyDraftRequestSchema,
  aiRunDiagnosisRequestSchema,
} from "../src/lib/api/business-evals-contracts.ts"
import {
  aiJourneyDraftSuggestionResponseSchema,
  aiJourneyDraftResponseSchema,
  aiRunDiagnosisResponseSchema,
} from "../src/lib/api/business-evals-response-schemas.ts"
import {
  assertJourneyAiSuggestionReferences,
  minimizeJourneyAssistanceInput,
  minimizeRunDiagnosisInput,
  redactTextForAi,
} from "../src/lib/ai/business-evals-ai-safety.ts"
import { parseStructuredOpenAiResponse } from "../src/lib/ai/openai-response-contract.ts"

const projectId = "019f7576-dbaa-7a02-9787-d0f9a03b48e4"
const journeyId = "019f7576-dbaa-7a02-9787-d0f9a03b48e5"
const runId = "019f7576-dbaa-7a02-9787-d0f9a03b48e6"

function journeyRequest() {
  return {
    projectId,
    journeyId,
    draftRevision: 4,
    template: "lead_form" as const,
    startUrl: "https://example.com/contact?campaign=private#form",
    objective: "Prove that a lead reaches owner@example.com using token=secret-value.",
    fields: [{
      key: "email-field",
      control: "input" as const,
      inputType: "email",
      label: "Work email",
      name: "email",
      required: true,
      options: [],
      locator: { kind: "label" as const, value: "Work email" },
      currentValueKey: null,
    }],
    actions: [{
      key: "submit-button",
      label: "Send",
      role: "button" as const,
      locator: { kind: "role" as const, role: "button", name: "Send" },
    }],
    stages: [{
      key: "submit",
      name: "Submit lead",
      position: 0,
      expected: "A deterministic confirmation appears.",
      businessImpact: "",
    }],
  }
}

function journeySuggestions() {
  return {
    fieldMappings: [{ fieldKey: "email-field", valueKey: "email" as const, reason: "Use the run address." }],
    locators: [{
      target: "submit" as const,
      targetKey: "submit-button",
      locator: { kind: "role" as const, role: "button", name: "Send" },
      reason: "The accessible button name is explicit.",
    }],
    businessImpacts: [{
      stageKey: "submit",
      text: "If this stage fails, a prospective customer may be unable to submit an enquiry.",
      reason: "This stage records the customer-visible handoff.",
    }],
    cautions: ["Confirm the field mapping before saving."],
  }
}

test("AI journey input accepts only reduced semantic builder context", () => {
  assert.equal(aiJourneyDraftRequestSchema.safeParse(journeyRequest()).success, true)
  assert.equal(aiRunDiagnosisRequestSchema.safeParse({ runId }).success, true)
  assert.equal(aiJourneyDraftRequestSchema.safeParse({ ...journeyRequest(), rawDom: "<html>secret</html>" }).success, false)
  assert.equal(aiJourneyDraftRequestSchema.safeParse({
    ...journeyRequest(),
    fields: [{ ...journeyRequest().fields[0], locator: { kind: "css", value: "#email" } }],
  }).success, false)
  assert.equal(aiJourneyDraftRequestSchema.safeParse({ ...journeyRequest(), draftRevision: null }).success, false)
})

test("AI input minimization removes URL secrets, credentials, email, phone and synthetic markers", () => {
  const parsed = aiJourneyDraftRequestSchema.parse(journeyRequest())
  const minimized = minimizeJourneyAssistanceInput(parsed)
  const serialized = JSON.stringify(minimized)
  assert.equal(minimized.target.origin, "https://example.com")
  assert.equal(minimized.target.pathname, "/contact")
  assert.doesNotMatch(serialized, /campaign|private|owner@example\.com|secret-value/)
  assert.match(serialized, /REDACTED/)

  const redacted = redactTextForAi(
    "Bearer abc.def.ghi api_key=MF_TEST_CREDENTIAL_4A4F19E708D74BB7 +353 87 123 4567 MF-EVAL-ABCDEF0123456789ABCD",
    500
  )
  assert.doesNotMatch(redacted, /abc\.def\.ghi|MF_TEST_CREDENTIAL_4A4F19E708D74BB7|353 87|ABCDEF0123456789ABCD/)
  assert.match(redacted, /api_key=\[REDACTED\]/)
})

test("AI journey outputs are strict drafts and cannot reference invented builder keys", () => {
  const input = aiJourneyDraftRequestSchema.parse(journeyRequest())
  const suggestions = aiJourneyDraftSuggestionResponseSchema.parse(journeySuggestions())
  assert.doesNotThrow(() => assertJourneyAiSuggestionReferences(input, suggestions))
  assert.throws(() => assertJourneyAiSuggestionReferences(input, {
    ...suggestions,
    fieldMappings: [{ ...suggestions.fieldMappings[0], fieldKey: "invented-field" }],
  }), /AI_FIELD_REFERENCE_INVALID/)
  assert.throws(() => assertJourneyAiSuggestionReferences(input, {
    ...suggestions,
    businessImpacts: [{ ...suggestions.businessImpacts[0], stageKey: "invented-stage" }],
  }), /AI_STAGE_REFERENCE_INVALID/)

  const publicDraft = aiJourneyDraftResponseSchema.parse({
    ...suggestions,
    requestId: runId,
    status: "draft",
    reviewRequired: true,
    publishable: false,
    model: "gpt-5.6-sol",
    baseDraftRevision: 4,
  })
  assert.equal(publicDraft.publishable, false)
  assert.equal(publicDraft.reviewRequired, true)
})

test("telephone, hidden, file, checkbox and select mappings fail closed", () => {
  const suggestions = aiJourneyDraftSuggestionResponseSchema.parse(journeySuggestions())
  for (const [control, inputType] of [
    ["input", "tel"],
    ["input", "hidden"],
    ["input", "file"],
    ["input", "checkbox"],
    ["select", "select-one"],
  ] as const) {
    const input = aiJourneyDraftRequestSchema.parse({
      ...journeyRequest(),
      fields: [{ ...journeyRequest().fields[0], control, inputType }],
    })
    assert.throws(() => assertJourneyAiSuggestionReferences(input, suggestions), /AI_FIELD_MAPPING_UNSAFE/)
  }
})

test("run diagnosis minimization uses an allowlist instead of raw diagnostics or evidence", () => {
  const reduced = minimizeRunDiagnosisInput({
    run: {
      source: "business_eval",
      verdict: "inconclusive",
      status: "finalized",
      stages: [{
        stage_definition_id: journeyId,
        position: 0,
        verdict: "inconclusive",
        expected_text: "Confirmation",
        observed_text: "owner@example.com token=private",
        error_code: "LOCATOR_AMBIGUOUS",
        diagnostics_json: {
          errorCode: "LOCATOR_AMBIGUOUS",
          ambiguousMatchCount: 2,
          cookies: "session=private",
          rawDom: "<html>secret</html>",
        },
        assertion_results_json: [{ type: "visible", result: "inconclusive", expected: "Confirmation", observed: "" }],
      }],
      evidence: [{ storage_path: "private/trace.zip" }],
    },
    journeyStages: [{ id: journeyId, stage_key: "confirmation", name: "Confirmation" }],
  })
  const serialized = JSON.stringify(reduced)
  assert.match(serialized, /LOCATOR_AMBIGUOUS/)
  assert.match(serialized, /ambiguousMatchCount/)
  assert.doesNotMatch(serialized, /cookies|session=private|rawDom|trace\.zip|owner@example\.com/)
})

test("Responses API output parsing handles completion, refusal, incompleteness and schema mismatch", () => {
  const suggestions = journeySuggestions()
  const completed = parseStructuredOpenAiResponse({
    id: "resp_123",
    model: "gpt-5.6-sol",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(suggestions) }] }],
    usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
  }, aiJourneyDraftSuggestionResponseSchema)
  assert.equal(completed.kind, "completed")
  if (completed.kind === "completed") assert.equal(completed.usage.totalTokens, 140)

  const refused = parseStructuredOpenAiResponse({
    id: "resp_refused",
    model: "gpt-5.6-sol",
    status: "completed",
    output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }],
  }, aiJourneyDraftSuggestionResponseSchema)
  assert.equal(refused.kind, "refused")

  assert.equal(parseStructuredOpenAiResponse({ status: "incomplete", output: [] }, aiJourneyDraftSuggestionResponseSchema).kind, "invalid")
  assert.equal(parseStructuredOpenAiResponse({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
  }, aiJourneyDraftSuggestionResponseSchema).kind, "invalid")
})

test("AI diagnosis response contract cannot represent a green verdict or a mutation", () => {
  const valid = aiRunDiagnosisResponseSchema.safeParse({
    requestId: runId,
    status: "draft",
    reviewRequired: true,
    model: "gpt-5.6-sol",
    sourceVerdict: "failed",
    summary: "The confirmation assertion failed.",
    likelyCause: "The expected visible state was not recorded.",
    nextSteps: ["Review the failed stage evidence."],
    evidenceGaps: [],
    caution: "The recorded verdict remains unchanged.",
  })
  assert.equal(valid.success, true)
  assert.equal(aiRunDiagnosisResponseSchema.safeParse({
    ...(valid.success ? valid.data : {}),
    sourceVerdict: "passed",
  }).success, false)
  assert.equal(aiRunDiagnosisResponseSchema.safeParse({
    ...(valid.success ? valid.data : {}),
    verdictOverride: "passed",
  }).success, false)
})

test("AI server routes enforce tenancy, role, idempotency and non-mutating services", () => {
  const journeyRoute = readFileSync("src/app/api/business-evals/ai/journey-draft/route.ts", "utf8")
  const diagnosisRoute = readFileSync("src/app/api/business-evals/ai/run-diagnosis/route.ts", "utf8")
  const service = readFileSync("src/lib/api/business-evals-ai.server.ts", "utf8")
  const provider = readFileSync("src/lib/ai/openai-responses.server.ts", "utf8")

  assert.match(journeyRoute, /requireBusinessEvalsAuth\(request, \{ roles: \["owner", "admin"\] \}\)/)
  assert.match(diagnosisRoute, /requireBusinessEvalsAuth\(request\)/)
  assert.match(journeyRoute, /requireIdempotencyKey\(request\)/)
  assert.match(diagnosisRoute, /requireIdempotencyKey\(request\)/)
  assert.match(service, /assertProjectAuthorizedForUrl/)
  assert.match(service, /DRAFT_VERSION_CONFLICT/)
  assert.match(service, /AI_DIAGNOSIS_NOT_AVAILABLE/)
  assert.match(service, /sourceVerdict[\s\S]+failed[\s\S]+inconclusive/)
  assert.doesNotMatch(service, /updateJourneyDraft|publishJourneyVersion|finalizeBusinessEvalRun|verdict\s*:/)

  assert.match(provider, /https:\/\/api\.openai\.com\/v1\/responses/)
  assert.match(provider, /gpt-5\.6-sol/)
  assert.match(provider, /store: false/)
  assert.match(provider, /reasoning: \{ effort: input\.reasoningEffort \}/)
  assert.match(provider, /type: "json_schema"/)
  assert.match(provider, /safety_identifier/)
  assert.doesNotMatch(provider, /console\.(?:log|error)|tools:/)
})

test("AI persistence stores hashes and safe drafts with service-only RLS and audit events", () => {
  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  assert.match(migration, /create table if not exists public\.ai_assistance_requests/)
  assert.match(migration, /idempotency_key_hash text not null/)
  assert.match(migration, /request_hash text not null/)
  assert.doesNotMatch(migration, /ai_assistance_requests[\s\S]{0,1800}raw_prompt|prompt_json|input_json/)
  assert.match(migration, /ai_assistance_requests_agency_idempotency_unique unique \(agency_id, idempotency_key_hash\)/)
  assert.match(migration, /create or replace function public\.claim_business_eval_ai_request/)
  assert.match(migration, /AI_IDEMPOTENCY_KEY_REUSED/)
  assert.match(migration, /create or replace function public\.finish_business_eval_ai_request/)
  assert.match(migration, /ai_assistance_request_finalized/)
  assert.match(migration, /alter table public\.ai_assistance_requests enable row level security/)
  assert.match(migration, /revoke all on table public\.ai_assistance_requests from public, anon, authenticated/)
  assert.match(migration, /'ai_user', 'ai_workspace', 'ai_project'/)
})
