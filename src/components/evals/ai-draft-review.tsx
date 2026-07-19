"use client"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  IconAlertTriangle,
  IconCheck,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react"

export type AiDraftFieldLocator =
  | { kind: "label" | "placeholder" | "test_id"; value: string }

export type AiDraftSubmitLocator = {
  kind: "role"
  role: "button"
  name: string
}

export type JourneyAiDraftSuggestion =
  | {
      id: string
      kind: "field_mapping"
      fieldKey: string
      fieldLabel: string
      valueKey: string
      currentValue?: string
      rationale: string
    }
  | {
      id: string
      kind: "locator"
      target: "field" | "submit"
      targetKey: string
      targetLabel: string
      locator: AiDraftFieldLocator | AiDraftSubmitLocator
      currentValue?: string
      rationale: string
    }
  | {
      id: string
      kind: "business_impact"
      stageKey: string
      stageName: string
      impact: string
      currentValue?: string
      rationale: string
    }

export type JourneyAiDraft = {
  requestId: string
  model: string
  baseDraftRevision: number | null
  suggestions: JourneyAiDraftSuggestion[]
  cautions: string[]
}

export type EvalRunAiDiagnosis = {
  requestId: string
  model: string
  sourceVerdict: "failed" | "inconclusive"
  summary: string
  likelyCause: string
  nextSteps: string[]
  evidenceGaps: string[]
  caution: string
}

export function JourneyAiDraftReview({
  section,
  draft,
  loading,
  error,
  appliedSuggestionIds,
  onRequest,
  onApply,
}: {
  section: "configuration" | "impact"
  draft: JourneyAiDraft | null
  loading: boolean
  error: string
  appliedSuggestionIds: ReadonlySet<string>
  onRequest: () => void
  onApply: (suggestion: JourneyAiDraftSuggestion) => void
}) {
  const suggestions = (draft?.suggestions ?? []).filter((suggestion) => section === "impact"
    ? suggestion.kind === "business_impact"
    : suggestion.kind !== "business_impact")
  const title = section === "impact" ? "AI impact drafts" : "AI mapping and locator drafts"
  const requestLabel = section === "impact" ? "Suggest impact wording" : "Suggest safe configuration"

  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50/40" aria-labelledby={`ai-draft-${section}-title`}>
      <header className="flex flex-col gap-3 border-b border-blue-100 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IconSparkles className="size-4 shrink-0 text-blue-600" aria-hidden="true" />
            <h3 id={`ai-draft-${section}-title`} className="text-sm font-semibold text-slate-950">{title}</h3>
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">Draft</span>
          </div>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-600">
            AI can propose supported choices, but it cannot publish a version, change a verdict, or enable a schedule. Review and apply each suggestion yourself.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRequest}
          disabled={loading}
          className="shrink-0 rounded-md border-blue-200 bg-white text-blue-700 hover:bg-blue-50"
        >
          {draft ? <IconRefresh data-icon="inline-start" /> : <IconSparkles data-icon="inline-start" />}
          {loading ? "Drafting…" : draft ? "Refresh drafts" : requestLabel}
        </Button>
      </header>

      <div className="px-4 py-4">
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            <IconAlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{error} Your deterministic configuration is unchanged and remains fully editable.</span>
          </div>
        ) : null}

        {!error && !draft ? (
          <p className="text-xs leading-5 text-slate-500">
            Optional assistance only. You can continue configuring this journey without AI.
          </p>
        ) : null}

        {draft && !suggestions.length ? (
          <p className="rounded-md border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600">
            AI did not return a safe {section === "impact" ? "impact" : "mapping or locator"} suggestion. No draft values changed.
          </p>
        ) : null}

        {suggestions.length ? (
          <div className="flex flex-col gap-3">
            {suggestions.map((suggestion) => {
              const applied = appliedSuggestionIds.has(suggestion.id)
              return (
                <article key={suggestion.id} className={cn("rounded-md border bg-white p-3", applied ? "border-emerald-200" : "border-slate-200")}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{suggestionLabel(suggestion)}</p>
                      <p className="mt-1 text-sm font-medium text-slate-950">{suggestionTarget(suggestion)}</p>
                      {suggestion.currentValue ? <p className="mt-2 break-words text-xs text-slate-500">Current: {suggestion.currentValue}</p> : null}
                      <p className="mt-1 break-words text-sm leading-6 text-slate-700">Suggested: {suggestionValue(suggestion)}</p>
                      <p className="mt-2 text-xs leading-5 text-slate-500">{suggestion.rationale}</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={applied ? "outline" : "default"}
                      disabled={applied}
                      onClick={() => onApply(suggestion)}
                      className={cn("shrink-0 rounded-md", applied ? "border-emerald-200 text-emerald-700" : "bg-blue-600 hover:bg-blue-700")}
                    >
                      {applied ? <IconCheck data-icon="inline-start" /> : null}
                      {applied ? "Applied to draft" : "Apply to draft"}
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        ) : null}

        {draft?.cautions.length ? (
          <div className="mt-3 rounded-md border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600">
            <p className="font-medium text-slate-800">Review notes</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {draft.cautions.map((caution) => <li key={caution}>{caution}</li>)}
            </ul>
          </div>
        ) : null}

        {draft ? (
          <p className="mt-3 text-[11px] leading-5 text-slate-500">
            Applying a suggestion changes only this unpublished form state. It takes effect only after you review the complete deterministic manifest and choose Save and publish version. Draft generated by {draft.model}.
          </p>
        ) : null}
      </div>
    </section>
  )
}

export function EvalRunAiDiagnosisPanel({
  status,
  diagnosis,
  loading,
  error,
  onRequest,
}: {
  status: "failed" | "inconclusive"
  diagnosis: EvalRunAiDiagnosis | null
  loading: boolean
  error: string
  onRequest: () => void
}) {
  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50/40" aria-labelledby="ai-run-diagnosis-title">
      <header className="border-b border-blue-100 px-4 py-4">
        <div className="flex items-center gap-2">
          <IconSparkles className="size-4 text-blue-600" aria-hidden="true" />
          <h2 id="ai-run-diagnosis-title" className="text-sm font-semibold text-slate-950">AI diagnosis</h2>
          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">Draft</span>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-600">
          Explain the retained evidence and propose next checks. The immutable {status} verdict and its source evidence cannot be changed by AI.
        </p>
      </header>
      <div className="px-4 py-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRequest}
          disabled={loading}
          className="w-full rounded-md border-blue-200 bg-white text-blue-700 hover:bg-blue-50"
        >
          {diagnosis ? <IconRefresh data-icon="inline-start" /> : <IconSparkles data-icon="inline-start" />}
          {loading ? "Reviewing evidence…" : diagnosis ? "Refresh draft diagnosis" : "Request draft diagnosis"}
        </Button>

        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            {error} The deterministic evidence and verdict remain available above.
          </p>
        ) : null}

        {diagnosis ? (
          <div className="mt-4 flex flex-col gap-4 text-sm">
            <DiagnosisValue label="Draft summary" value={diagnosis.summary} />
            <DiagnosisValue label="Likely cause to verify" value={diagnosis.likelyCause} />
            <DiagnosisList label="Suggested next checks" values={diagnosis.nextSteps} empty="No safe next check was suggested." />
            <DiagnosisList label="Evidence gaps" values={diagnosis.evidenceGaps} empty="No evidence gaps were identified." />
            <DiagnosisValue label="Evidence boundary" value={diagnosis.caution} />
            <p className="rounded-md border border-slate-200 bg-white p-3 text-[11px] leading-5 text-slate-500">
              Review this draft against the stage evidence before recording any repair. AI cannot mark the incident resolved or turn this run green. Draft generated by {diagnosis.model}.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function suggestionLabel(suggestion: JourneyAiDraftSuggestion) {
  if (suggestion.kind === "field_mapping") return "Synthetic mapping"
  if (suggestion.kind === "locator") return suggestion.target === "submit" ? "Submit locator" : "Field locator"
  return "Business impact"
}

function suggestionTarget(suggestion: JourneyAiDraftSuggestion) {
  if (suggestion.kind === "field_mapping") return suggestion.fieldLabel
  if (suggestion.kind === "locator") return suggestion.targetLabel
  return suggestion.stageName
}

function suggestionValue(suggestion: JourneyAiDraftSuggestion) {
  if (suggestion.kind === "field_mapping") return suggestion.valueKey.replaceAll("_", " ")
  if (suggestion.kind === "locator") return formatLocator(suggestion.locator)
  return suggestion.impact
}

function formatLocator(locator: AiDraftFieldLocator | AiDraftSubmitLocator) {
  if (locator.kind === "role") return `Role ${locator.role} named “${locator.name}”`
  return `${locator.kind.replaceAll("_", "-")} “${locator.value}”`
}

function DiagnosisValue({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 leading-6 text-slate-700">{value}</p></div>
}

function DiagnosisList({ label, values, empty }: { label: string; values: string[]; empty: string }) {
  return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>{values.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-sm leading-6 text-slate-700">{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p className="mt-1 text-xs leading-5 text-slate-500">{empty}</p>}</div>
}
