"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { IconArrowRight, IconCopy, IconPlus, IconRoute, IconSearch } from "@tabler/icons-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { businessEvalsRequest, createIdempotencyKey } from "@/lib/api/business-evals-client"
import { journeyDraftSchema } from "@/lib/api/business-evals-contracts"
import {
  aiJourneyDraftResponseSchema,
  evalRunResponseSchema,
  forwardingAddressResponseSchema,
  journeyScanResponseSchema,
  publishedJourneyResponseSchema,
} from "@/lib/api/business-evals-response-schemas"
import { journeyTemplateDefinition } from "@/lib/evals/templates"
import {
  compileOperatorApprovedCheckActions,
  controlMappingsAreReady,
  groupRadioFields,
  inferSyntheticValueKey,
  isCheckboxField,
  isPhoneLikeField,
  isRadioField,
  isSupportedFormField,
  isSyntheticTextField,
  safeSyntheticValueKeys,
  type SafeSyntheticValueKey,
} from "@/lib/evals/form-control-mapping"
import { mapRun } from "../api-adapters"
import {
  JourneyAiDraftReview,
  type AiDraftFieldLocator,
  type AiDraftSubmitLocator,
  type JourneyAiDraft,
  type JourneyAiDraftSuggestion,
} from "../ai-draft-review"
import { useEvals } from "../evals-provider"
import { CollectionLoadMore, EvalBreadcrumbs, EvalPage, EmptyPanel, PageHeading } from "../page-primitives"
import { StatusLabel } from "../status-ui"
import type { JourneyDraft } from "../types"

type ScanResult = {
  url: string
  title: string
  captchaDetected: boolean
  fields: Array<{
    key: string
    control: "input" | "textarea" | "select"
    inputType: string
    label: string
    name: string
    required: boolean
    options: Array<{ value: string; label: string; disabled: boolean }>
    locator: { kind: "label" | "placeholder" | "test_id"; value: string } | null
  }>
  actions: Array<{ key: string; label: string; locator: { kind: "role"; role: "button" | "link"; name: string } }>
  warnings: string[]
  approvedActionDomains: string[]
}

export function JourneysPage() {
  const { journeys, projects, activeProjectId, pagination } = useEvals()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlQuery = searchParams.get("search") ?? ""
  const urlFilter = journeyListFilter(searchParams.get("status"))
  const [query, setQuery] = useState(urlQuery)
  const [filter, setFilter] = useState<"all" | "attention" | "passed">(urlFilter)

  useEffect(() => {
    setQuery(urlQuery)
    setFilter(urlFilter)
  }, [urlFilter, urlQuery])

  useEffect(() => {
    if (query === urlQuery && filter === urlFilter) return
    const timeout = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams.toString())
      if (query.trim()) next.set("search", query.trim())
      else next.delete("search")
      if (filter === "all") next.delete("status")
      else next.set("status", filter)
      const destination = next.size ? `${pathname}?${next.toString()}` : pathname
      router.replace(destination, { scroll: false })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [filter, pathname, query, router, searchParams, urlFilter, urlQuery])

  const visible = useMemo(() => journeys.filter((journey) => {
    const matchesQuery = `${journey.name} ${journey.description}`.toLowerCase().includes(query.toLowerCase())
    const matchesFilter = filter === "all" || (filter === "passed" ? journey.status === "passed" : journey.status === "failed" || journey.status === "degraded")
    return matchesQuery && matchesFilter
  }), [filter, journeys, query])

  return (
    <EvalPage>
      <PageHeading
        title="Journeys"
        description="Prove critical customer journeys from the first action to the business outcome that matters."
        action={<Button nativeButton={false} render={<Link href={`/journeys/new?project=${activeProjectId}`} />} className="rounded-md bg-blue-600 hover:bg-blue-700"><IconPlus data-icon="inline-start" />New journey</Button>}
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block w-full max-w-md">
          <span className="sr-only">Search journeys</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search journeys" className="rounded-md border-slate-200 bg-white pl-9" />
        </label>
        <div className="flex rounded-md border border-slate-200 bg-white p-1" aria-label="Filter journeys">
          {(["all", "attention", "passed"] as const).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`rounded px-3 py-1.5 text-xs font-medium capitalize ${filter === item ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{item}</button>)}
        </div>
      </div>
      {visible.length ? (
        <Card className="gap-0 rounded-lg border border-slate-200 bg-white py-0 shadow-none ring-0">
          <CardContent className="divide-y divide-slate-200 px-0">
            {visible.map((journey) => {
              const project = projects.find((item) => item.id === journey.projectId)
              const failedStage = journey.stages.find((stage) => stage.status === "failed" || stage.status === "degraded")
              return (
                <Link key={journey.id} href={`/journeys/${journey.id}`} className="grid gap-4 px-5 py-5 transition hover:bg-slate-50 md:grid-cols-[minmax(0,1fr)_130px_140px_170px_24px] md:items-center">
                  <span className="flex min-w-0 items-start gap-3"><span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><IconRoute className="size-5" /></span><span className="min-w-0"><span className="block truncate font-medium text-slate-950">{journey.name}</span><span className="mt-1 block truncate text-xs text-slate-500">{project?.name ?? journey.projectName ?? "Historical project"} · {journey.environment}</span>{failedStage ? <span className="mt-2 block text-xs font-medium text-amber-700">Attention at {failedStage.name}</span> : null}</span></span>
                  <StatusLabel status={journey.status} />
                  <span className="text-xs text-slate-500"><span className="block font-medium text-slate-700">{journeyCoverageLabel(journey)}</span><span className="mt-1 block">Coverage</span></span>
                  <span className="text-xs text-slate-500"><span className="block">{journey.schedule}</span><span className="mt-1 block">{journey.lastRunAt}</span></span>
                  <IconArrowRight className="hidden size-4 text-slate-400 md:block" />
                </Link>
              )
            })}
          </CardContent>
        </Card>
      ) : <EmptyPanel title="No matching journeys" description="Change the search or filter to see more journeys." />}
      <CollectionLoadMore state={pagination.journeys} label="journeys" />
    </EvalPage>
  )
}

function journeyListFilter(value: string | null): "all" | "attention" | "passed" {
  return value === "attention" || value === "passed" ? value : "all"
}

export function JourneyFormPage({ journeyId }: { journeyId?: string }) {
  const { journeys, projects, runs, createJourney, updateJourney, runJourney, configureJourneySchedule, workspaceId } = useEvals()
  const existing = journeyId ? journeys.find((journey) => journey.id === journeyId) : undefined
  const searchParams = useSearchParams()
  const router = useRouter()
  const defaultProject = existing?.projectId ?? searchParams.get("project") ?? projects[0]?.id ?? ""
  const requestedTemplate = searchParams.get("template") === "trial_signup" ? "trial_signup" : "lead_form"
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [name, setName] = useState(existing?.name ?? "")
  const [projectId, setProjectId] = useState(defaultProject)
  const [template, setTemplate] = useState<"lead_form" | "trial_signup">(existing?.template === "trial_signup" ? "trial_signup" : requestedTemplate)
  const [startUrl, setStartUrl] = useState(existing?.startUrl ?? "")
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [fieldMappings, setFieldMappings] = useState<Record<string, SafeSyntheticValueKey>>({})
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({})
  const [fieldLocatorOverrides, setFieldLocatorOverrides] = useState<Record<string, AiDraftFieldLocator>>({})
  const [submitLocatorOverrides, setSubmitLocatorOverrides] = useState<Record<string, AiDraftSubmitLocator>>({})
  const [businessImpactOverrides, setBusinessImpactOverrides] = useState<Record<string, string>>({})
  const [approvedCheckboxes, setApprovedCheckboxes] = useState<Record<string, boolean>>({})
  const [radioChoices, setRadioChoices] = useState<Record<string, string>>({})
  const [messageFieldIndex, setMessageFieldIndex] = useState(-1)
  const [actionIndex, setActionIndex] = useState(0)
  const [successMode, setSuccessMode] = useState<"text" | "url" | "visible_state">(existingLeadSuccessMode(existing?.rawDraft))
  const [successText, setSuccessText] = useState(existingStageText(existing?.rawDraft, "success_confirmed") ?? "Thank you")
  const [successUrl, setSuccessUrl] = useState(existingLeadSuccessUrl(existing?.rawDraft) ?? "")
  const [successStateRole, setSuccessStateRole] = useState(existingLeadSuccessLocator(existing?.rawDraft)?.role ?? "status")
  const [successStateName, setSuccessStateName] = useState(existingLeadSuccessLocator(existing?.rawDraft)?.name ?? "Lead received")
  const [emailProof, setEmailProof] = useState(template === "trial_signup" || Boolean(existing?.rawDraft?.emailProofConfigured))
  const [proofMode, setProofMode] = useState<"autoresponse" | "forwarded_marker">(existingLeadProofMode(existing?.rawDraft) ?? "autoresponse")
  const [emailThresholdSeconds, setEmailThresholdSeconds] = useState(existingEmailTiming(existing?.rawDraft).thresholdSeconds)
  const [emailMaximumWaitSeconds, setEmailMaximumWaitSeconds] = useState(existingEmailTiming(existing?.rawDraft).maximumWaitSeconds)
  const [verificationHost, setVerificationHost] = useState(existingVerificationHost(existing?.rawDraft) ?? "")
  const [verificationPathPrefix, setVerificationPathPrefix] = useState(existingVerificationRule(existing?.rawDraft)?.pathPrefix ?? "/verify")
  const [verificationRequiredText, setVerificationRequiredText] = useState(existingVerificationRule(existing?.rawDraft)?.requiredText ?? "Verify")
  const [verificationQueryParameter, setVerificationQueryParameter] = useState(existingVerificationRule(existing?.rawDraft)?.requiredQueryParameter ?? "token")
  const [accountStateText, setAccountStateText] = useState(existingStageText(existing?.rawDraft, "workspace_created") ?? "Workspace")
  const [cleanupMode, setCleanupMode] = useState<"in_product" | "webhook">(existingCleanupMode(existing?.rawDraft))
  const [deleteButtonName, setDeleteButtonName] = useState(existingCleanupButton(existing?.rawDraft) ?? "Delete test account")
  const [cleanupConfirmationText, setCleanupConfirmationText] = useState(existingCleanupConfirmation(existing?.rawDraft) ?? "Account deleted")
  const [cleanupWebhookUrl, setCleanupWebhookUrl] = useState(existingCleanupWebhook(existing?.rawDraft) ?? "")
  const [createdId, setCreatedId] = useState(existing?.id ?? "")
  const [runId, setRunId] = useState("")
  const [forwardingRecipient, setForwardingRecipient] = useState("")
  const [copyMessage, setCopyMessage] = useState("")
  const [aiDraft, setAiDraft] = useState<JourneyAiDraft | null>(null)
  const [aiDraftLoading, setAiDraftLoading] = useState(false)
  const [aiDraftError, setAiDraftError] = useState("")
  const [appliedAiSuggestionIds, setAppliedAiSuggestionIds] = useState<Set<string>>(() => new Set())
  const supervisedRunQuery = useQuery({
    queryKey: ["business-evals", workspaceId, "eval-runs", "supervised-gate", runId],
    enabled: Boolean(workspaceId && runId),
    queryFn: () => businessEvalsRequest(`/api/eval-runs/${encodeURIComponent(runId)}`, evalRunResponseSchema, { workspaceId }),
    refetchInterval: (query) => {
      const row = query.state.data?.data
      const status = typeof row?.status === "string" ? row.status : ""
      return ["queued", "claimed", "running", "waiting_for_email"].includes(status) ? 1_500 : false
    },
  })
  const supervisedRun = supervisedRunQuery.data
    ? mapRun(supervisedRunQuery.data.data)
    : runs.find((run) => run.id === runId)
  const supervisedPassed = supervisedRun?.status === "passed"
    && (template !== "trial_signup" || supervisedRun.cleanupStatus === "passed")
  const supervisedFinished = Boolean(supervisedRun && !["queued", "running"].includes(supervisedRun.status))

  useEffect(() => {
    if (!workspaceId || !existing?.id || existingLeadProofMode(existing.rawDraft) !== "forwarded_marker") return
    let active = true
    businessEvalsRequest(`/api/journeys/${encodeURIComponent(existing.id)}/forwarding-address`, forwardingAddressResponseSchema, { workspaceId })
      .then((result) => { if (active) setForwardingRecipient(result.data.forwardingRecipient ?? "") })
      // Members are intentionally not allowed to retrieve this address. The
      // builder remains usable and publication failures are handled separately.
      .catch(() => undefined)
    return () => { active = false }
  }, [existing?.id, existing?.rawDraft, workspaceId])

  async function scanPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    if (!name.trim() || !projectId || !startUrl.trim()) {
      setError("Choose a project, name the journey and add its public HTTPS start URL.")
      return
    }
    setSaving(true)
    try {
      const result = workspaceId
        ? (await businessEvalsRequest("/api/journey-scans", journeyScanResponseSchema, { workspaceId, method: "POST", body: JSON.stringify({ projectId, url: startUrl, template }) })).data
        : previewJourneyScan(startUrl, template)
      setScan(result)
      setAiDraft(null)
      setAiDraftError("")
      setAppliedAiSuggestionIds(new Set())
      setFieldLocatorOverrides({})
      setSubmitLocatorOverrides({})
      setBusinessImpactOverrides({})
      const detectedMessage = result.fields.findIndex((field) => /message|notes?|comments?|details/i.test(`${field.key} ${field.label}`))
      setMessageFieldIndex(detectedMessage)
      setFieldMappings(Object.fromEntries(result.fields.filter(isSyntheticTextField).map((field) => [field.key, inferSyntheticValueKey(field)])))
      setFieldChoices(Object.fromEntries(result.fields.filter((field) => field.control === "select").map((field) => {
        const option = field.options.find((item) => !item.disabled && item.value.trim()) ?? field.options.find((item) => !item.disabled)
        return [field.key, option?.value ?? ""]
      })))
      // Contact-consent controls never inherit an assumption from the scan or
      // from a previous draft. The operator must make every checked choice.
      setApprovedCheckboxes({})
      setRadioChoices({})
      setVerificationHost(result.approvedActionDomains[0] ?? new URL(result.url).hostname)
      if (result.captchaDetected) setError("A CAPTCHA was detected. Maintain Flow will not bypass it or schedule this journey.")
      else setStep(1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The public page could not be scanned. Confirm owner authorization on the project first.")
    } finally {
      setSaving(false)
    }
  }

  function buildDraft(): JourneyDraft {
    if (!scan) throw new Error("Scan the public form before building this journey.")
    const definition = journeyTemplateDefinition(template, startUrl)
    const configuredFields = withFieldLocatorOverrides(scan.fields, fieldLocatorOverrides)
    const selectedActionBase = scan.actions[actionIndex]
    if (!selectedActionBase) throw new Error("Choose one unambiguous submit action.")
    const selectedAction = {
      ...selectedActionBase,
      locator: submitLocatorOverrides[selectedActionBase.key] ?? selectedActionBase.locator,
    }
    const mappedFills = configuredFields.filter((field) => isSupportedFormField(field) && !isCheckboxField(field) && !isRadioField(field)).map((field, index) => {
      if (!field.locator) throw new Error(`Map ${field.label} using its semantic locator.`)
      if (field.control === "select") {
        const optionValue = fieldChoices[field.key]
        if (optionValue === undefined || !field.options.some((option) => !option.disabled && option.value === optionValue)) {
          throw new Error(`Choose one enabled option for ${field.label}.`)
        }
        return { id: `select_${safeFieldKey(field.key)}_${index}`, label: `Select the approved ${field.label} option`, type: "fill" as const, operation: "select" as const, locator: field.locator, optionValue, timeoutMs: 10_000 }
      }
      const mappedKey = template === "lead_form" && emailProof && proofMode === "forwarded_marker" && scan.fields[messageFieldIndex]?.key === field.key
        ? "message"
        : fieldMappings[field.key]
      if (!mappedKey) throw new Error(`Map ${field.label} to an approved synthetic value.`)
      return { id: `fill_${safeFieldKey(field.key)}_${index}`, label: `Fill ${field.label} with synthetic data`, type: "fill" as const, operation: "text" as const, locator: field.locator, valueKey: mappedKey, timeoutMs: 10_000 }
    })
    const approvedControlActions = compileOperatorApprovedCheckActions({
      fields: configuredFields,
      approvedCheckboxes,
      radioChoices,
    })
    if (mappedFills.length + approvedControlActions.length > 29) {
      throw new Error("The form has too many published field actions for one restricted submission stage.")
    }
    const stages = definition.stages.map((stage) => {
      const configuredStage = {
        ...stage,
        businessImpact: businessImpactOverrides[stage.key] ?? stage.businessImpact,
      }
      if (stage.actions.some((action) => action.type === "navigate")) {
        return { ...configuredStage, actions: stage.actions.filter((action) => action.type === "navigate") }
      }
      if (stage.actions.some((action) => action.type === "click")) {
        const click = stage.actions.find((action) => action.type === "click")
        return { ...configuredStage, actions: [...mappedFills, ...approvedControlActions, { ...click, locator: selectedAction.locator }] }
      }
      if (template === "lead_form" && stage.key === "success_confirmed") {
        if (successMode === "url") {
          return { ...configuredStage, actions: [{ id: "wait_for_success_url", label: "Confirm the success URL", type: "wait_for_url" as const, urlPattern: successUrl, timeoutMs: 10_000 }], expected: `The browser reaches ${successUrl}.` }
        }
        if (successMode === "visible_state") {
          return { ...configuredStage, actions: [{ id: "assert_success_state", label: "Confirm the visible form success state", type: "assert_visible" as const, locator: { kind: "role" as const, role: successStateRole, name: successStateName }, timeoutMs: 10_000 }], expected: `${successStateName} is visible as an accessible ${successStateRole} state.` }
        }
        return { ...configuredStage, actions: [{ id: "wait_for_success", label: "Wait for thank-you text", type: "wait_for_text" as const, text: successText, timeoutMs: 10_000 }], expected: `${successText} is visible after submission.` }
      }
      if (stage.actions.some((action) => action.type === "wait_for_email")) {
        return { ...configuredStage, actions: stage.actions.map((action) => action.type === "wait_for_email" ? { ...action, thresholdSeconds: emailThresholdSeconds, maximumWaitSeconds: emailMaximumWaitSeconds } : action) }
      }
      if (template === "trial_signup" && stage.key === "verification_opened") {
        return { ...configuredStage, actions: [{
          id: "open_verification_link",
          label: "Open the uniquely matched approved verification link",
          type: "open_email_link" as const,
          allowedHosts: [verificationHost],
          linkRule: {
            host: verificationHost,
            pathPrefix: verificationPathPrefix,
            ...(verificationRequiredText.trim() ? { requiredText: verificationRequiredText.trim() } : {}),
            ...(verificationQueryParameter.trim() ? { requiredQueryParameter: verificationQueryParameter.trim() } : {}),
          },
          timeoutMs: 10_000,
        }] }
      }
      if (template === "trial_signup" && stage.key === "workspace_created") {
        return { ...configuredStage, actions: [{ id: "expected_account_state", label: "Confirm expected account or workspace state", type: "wait_for_text" as const, text: accountStateText, timeoutMs: 10_000 }], expected: `${accountStateText} is visible after email verification.` }
      }
      if (template === "trial_signup" && stage.cleanup) {
        const actions = cleanupMode === "webhook"
          ? [{ id: "cleanup_test_account_webhook", label: "Remove synthetic account through approved cleanup webhook", type: "cleanup" as const, mode: "webhook" as const, webhookUrl: cleanupWebhookUrl, timeoutMs: 10_000 }]
          : [
              { id: "delete_test_account", label: "Delete synthetic test account", type: "cleanup" as const, mode: "in_product" as const, locator: { kind: "role" as const, role: "button", name: deleteButtonName }, timeoutMs: 10_000 },
              { id: "confirm_test_account_deleted", label: "Confirm test account deletion", type: "wait_for_text" as const, text: cleanupConfirmationText, timeoutMs: 10_000 },
            ]
        return { ...configuredStage, actions, expected: cleanupMode === "webhook" ? "The approved idempotent cleanup webhook confirms removal." : `${cleanupConfirmationText} is visible after the one permitted delete action.` }
      }
      return configuredStage
    })
    if (template === "lead_form" && emailProof) {
      stages.push({ key: "email_proof", name: "Email proof", position: stages.length, required: true, cleanup: false, actions: [{ id: "wait_for_lead_email", label: "Wait for proof email", type: "wait_for_email", recipientKey: proofMode === "forwarded_marker" ? "forwarding" : "email", proofMode, thresholdSeconds: emailThresholdSeconds, maximumWaitSeconds: emailMaximumWaitSeconds, timeoutMs: 60_000 }], expected: proofMode === "forwarded_marker" ? "The destination notification forwards the exact MF-EVAL marker into Maintain Flow." : "The autoresponse reaches the generated run-specific proof inbox.", businessImpact: businessImpactOverrides.email_proof ?? "Notification delivery is proven without accessing a private system.", timingThresholdMs: null })
    }
    const validated = journeyDraftSchema.parse({
      // Visual-QA fixtures retain readable route slugs. Validate every other
      // draft field against the production contract with an inert UUID, then
      // restore the preview-only project key for in-memory relationships.
      projectId: workspaceId ? projectId : "00000000-0000-4000-8000-000000000001",
      name,
      template,
      startUrl,
      draftRevision: existing?.draftRevision ?? 0,
      stages,
      emailProofConfigured: template === "trial_signup" || emailProof,
      cleanupMode: template === "trial_signup" ? cleanupMode : "none",
    })
    return workspaceId ? validated : { ...validated, projectId }
  }

  async function saveAndPublish() {
    setSaving(true); setError("")
    try {
      const draft = buildDraft()
      const journey = existing ? await updateJourney(existing.id, draft) : await createJourney(draft)
      if (workspaceId) {
        const published = await businessEvalsRequest(`/api/journeys/${encodeURIComponent(journey.id)}/publish`, publishedJourneyResponseSchema, { workspaceId, method: "POST", body: JSON.stringify({ expectedDraftRevision: journey.draftRevision ?? draft.draftRevision }) })
        setForwardingRecipient(published.data.forwardingRecipient ?? "")
      } else {
        setForwardingRecipient(template === "lead_form" && emailProof && proofMode === "forwarded_marker" ? "preview-forwarding@inbound.maintainflow.test" : "")
      }
      setCreatedId(journey.id)
      setStep(3)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The journey draft could not be published.") } finally { setSaving(false) }
  }

  async function startSupervisedRun() {
    if (!createdId) return
    setSaving(true); setError("")
    try { const run = await runJourney(createdId, "supervised"); setRunId(run.id); setStep(4) } catch (cause) { setError(cause instanceof Error ? cause.message : "The supervised run could not be queued.") } finally { setSaving(false) }
  }

  async function copyForwardingRecipient() {
    if (!forwardingRecipient) return
    try {
      await navigator.clipboard.writeText(forwardingRecipient)
      setCopyMessage("Forwarding address copied.")
    } catch {
      setCopyMessage("Copy was unavailable. Select the address and copy it manually.")
    }
  }

  async function requestAiDraft() {
    if (!scan) {
      setAiDraftError("Scan the public page before requesting an AI draft.")
      return
    }
    if (!workspaceId) {
      setAiDraftError("AI drafting is unavailable in the visual preview. Continue with the deterministic controls.")
      return
    }
    setAiDraftLoading(true)
    setAiDraftError("")
    try {
      const definition = journeyTemplateDefinition(template, startUrl)
      const configuredFields = withFieldLocatorOverrides(scan.fields, fieldLocatorOverrides)
      const stageContexts = [
        ...definition.stages.map((stage) => ({
          key: stage.key,
          name: stage.name,
          position: stage.position,
          expected: stage.expected,
          businessImpact: businessImpactOverrides[stage.key] ?? stage.businessImpact,
        })),
        ...(template === "lead_form" && emailProof ? [{
          key: "email_proof",
          name: "Email proof",
          position: definition.stages.length,
          expected: proofMode === "forwarded_marker"
            ? "The destination notification preserves the exact run marker."
            : "The autoresponse reaches the generated proof inbox.",
          businessImpact: businessImpactOverrides.email_proof ?? "Notification delivery is proven without accessing a private system.",
        }] : []),
      ]
      const response = await businessEvalsRequest(
        "/api/business-evals/ai/journey-draft",
        aiJourneyDraftResponseSchema,
        {
          workspaceId,
          method: "POST",
          idempotencyKey: createIdempotencyKey("ai-journey-draft"),
          body: JSON.stringify({
            projectId,
            journeyId: existing?.id ?? null,
            draftRevision: existing ? existing.draftRevision ?? 0 : null,
            template,
            startUrl,
            objective: name.trim()
              ? `Help configure the ${name.trim()} ${template === "lead_form" ? "lead form" : "trial signup"} journey using only the supported deterministic controls.`
              : `Help configure this ${template === "lead_form" ? "lead form" : "trial signup"} journey using only the supported deterministic controls.`,
            fields: configuredFields.map((field) => ({
              key: field.key,
              control: field.control,
              inputType: field.inputType.slice(0, 40),
              label: field.label.slice(0, 200),
              name: field.name.slice(0, 200),
              required: field.required,
              options: field.options.slice(0, 50).map((option) => ({
                value: option.value.trim().slice(0, 200),
                label: option.label.trim().slice(0, 200),
                disabled: option.disabled,
              })),
              locator: field.locator,
              currentValueKey: fieldMappings[field.key] ?? null,
            })),
            actions: scan.actions.map((action) => ({
              key: action.key,
              label: action.label,
              role: "button",
              locator: submitLocatorOverrides[action.key] ?? action.locator,
            })),
            stages: stageContexts,
          }),
        }
      )
      const fieldByKey = new Map(configuredFields.map((field) => [field.key, field]))
      const actionByKey = new Map(scan.actions.map((action) => [action.key, action]))
      const stageByKey = new Map(stageContexts.map((stage) => [stage.key, stage]))
      const suggestions: JourneyAiDraftSuggestion[] = response.data.fieldMappings.map((suggestion, index) => {
        const field = fieldByKey.get(suggestion.fieldKey)
        return {
          id: `${response.data.requestId}:mapping:${index}`,
          kind: "field_mapping",
          fieldKey: suggestion.fieldKey,
          fieldLabel: field?.label || suggestion.fieldKey,
          valueKey: suggestion.valueKey,
          ...(fieldMappings[suggestion.fieldKey] ? { currentValue: syntheticValueLabel(fieldMappings[suggestion.fieldKey]) } : {}),
          rationale: suggestion.reason,
        }
      })
      response.data.locators.forEach((suggestion, index) => {
        const field = fieldByKey.get(suggestion.targetKey)
        const action = actionByKey.get(suggestion.targetKey)
        if (suggestion.target === "field" && field && suggestion.locator.kind !== "role") {
          suggestions.push({
            id: `${response.data.requestId}:locator:${index}`,
            kind: "locator",
            target: "field",
            targetKey: suggestion.targetKey,
            targetLabel: field.label || suggestion.targetKey,
            locator: suggestion.locator,
            ...(field.locator ? { currentValue: locatorSummary(field.locator) } : {}),
            rationale: suggestion.reason,
          })
        } else if (suggestion.target === "submit" && action && suggestion.locator.kind === "role" && suggestion.locator.role === "button") {
          suggestions.push({
            id: `${response.data.requestId}:locator:${index}`,
            kind: "locator",
            target: "submit",
            targetKey: suggestion.targetKey,
            targetLabel: action.label,
            locator: { ...suggestion.locator, role: "button" },
            currentValue: locatorSummary(submitLocatorOverrides[action.key] ?? action.locator),
            rationale: suggestion.reason,
          })
        }
      })
      response.data.businessImpacts.forEach((suggestion, index) => {
        const stage = stageByKey.get(suggestion.stageKey)
        if (!stage) return
        suggestions.push({
          id: `${response.data.requestId}:impact:${index}`,
          kind: "business_impact",
          stageKey: suggestion.stageKey,
          stageName: stage.name,
          impact: suggestion.text,
          currentValue: stage.businessImpact,
          rationale: suggestion.reason,
        })
      })
      setAiDraft({
        requestId: response.data.requestId,
        model: response.data.model,
        baseDraftRevision: response.data.baseDraftRevision,
        suggestions,
        cautions: response.data.cautions,
      })
      setAppliedAiSuggestionIds(new Set())
    } catch (cause) {
      setAiDraftError(cause instanceof Error ? cause.message : "AI drafting is temporarily unavailable.")
    } finally {
      setAiDraftLoading(false)
    }
  }

  function applyAiSuggestion(suggestion: JourneyAiDraftSuggestion) {
    const currentDraftRevision = existing ? existing.draftRevision ?? 0 : null
    if (aiDraft?.baseDraftRevision !== currentDraftRevision) {
      setAiDraftError("This AI draft was created from an older journey revision. Refresh the suggestions before applying anything.")
      return
    }
    const currentSuggestion = aiDraft?.suggestions.find((candidate) => candidate.id === suggestion.id)
    if (!currentSuggestion || currentSuggestion.kind !== suggestion.kind) {
      setAiDraftError("This suggestion is no longer part of the current AI draft. Refresh and review again.")
      return
    }
    if (currentSuggestion.kind === "field_mapping") {
      const field = withFieldLocatorOverrides(scan?.fields ?? [], fieldLocatorOverrides)
        .find((candidate) => candidate.key === currentSuggestion.fieldKey)
      if (!field || !isSyntheticTextField(field) || !safeSyntheticValueKeys.includes(currentSuggestion.valueKey as SafeSyntheticValueKey)) {
        setAiDraftError("The suggested field mapping is outside the approved synthetic value set and was not applied.")
        return
      }
      setFieldMappings((current) => ({ ...current, [field.key]: currentSuggestion.valueKey as SafeSyntheticValueKey }))
    } else if (currentSuggestion.kind === "locator" && currentSuggestion.target === "field") {
      const field = scan?.fields.find((candidate) => candidate.key === currentSuggestion.targetKey)
      const locator = currentSuggestion.locator
      if (!field || locator.kind === "role") {
        setAiDraftError("The suggested field locator is not a supported semantic locator and was not applied.")
        return
      }
      setFieldLocatorOverrides((current) => ({ ...current, [field.key]: locator }))
    } else if (currentSuggestion.kind === "locator") {
      const actionIndexForSuggestion = scan?.actions.findIndex((action) => action.key === currentSuggestion.targetKey) ?? -1
      const locator = currentSuggestion.locator
      if (actionIndexForSuggestion < 0 || locator.kind !== "role" || locator.role !== "button") {
        setAiDraftError("The suggested submit locator is not one of the scanned button actions and was not applied.")
        return
      }
      setActionIndex(actionIndexForSuggestion)
      setSubmitLocatorOverrides((current) => ({ ...current, [currentSuggestion.targetKey]: locator }))
    } else {
      const allowedStages = new Set([
        ...journeyTemplateDefinition(template, startUrl).stages.map((stage) => stage.key),
        ...(template === "lead_form" && emailProof ? ["email_proof"] : []),
      ])
      if (!allowedStages.has(currentSuggestion.stageKey) || !currentSuggestion.impact.trim()) {
        setAiDraftError("The suggested impact does not match a stage in this draft and was not applied.")
        return
      }
      setBusinessImpactOverrides((current) => ({ ...current, [currentSuggestion.stageKey]: currentSuggestion.impact.trim() }))
    }
    setAiDraftError("")
    setAppliedAiSuggestionIds((current) => new Set(current).add(currentSuggestion.id))
  }

  async function enableSchedule() {
    if (!createdId) return
    if (!supervisedPassed) {
      setError("Scheduling remains locked until this supervised run passes and required cleanup is verified.")
      return
    }
    setSaving(true); setError("")
    try { await configureJourneySchedule(createdId, true, 1_440); router.push(`/journeys/${createdId}`) } catch (cause) { setError(cause instanceof Error ? cause.message : "Scheduling remains locked until the supervised run passes and cleanup is verified.") } finally { setSaving(false) }
  }

  const configuredFields = withFieldLocatorOverrides(scan?.fields ?? [], fieldLocatorOverrides)
  const supportedFields = configuredFields.filter(isSupportedFormField)
  const unsupportedRequiredFields = configuredFields.filter((field) => field.required && !isSupportedFormField(field))
  const radioGroups = groupRadioFields(configuredFields)
  const approvedControlCount = configuredFields.filter((field) => isCheckboxField(field) && approvedCheckboxes[field.key]).length
    + radioGroups.filter((group) => Boolean(radioChoices[group.key])).length
  const nonControlFieldCount = supportedFields.filter((field) => !isCheckboxField(field) && !isRadioField(field)).length
  const tooManySupportedFields = nonControlFieldCount + approvedControlCount > 29
  const controlsMapped = controlMappingsAreReady({ fields: configuredFields, approvedCheckboxes, radioChoices })
  const fieldsMapped = supportedFields.some(isSyntheticTextField) && supportedFields.every((field) => {
    if (field.control === "select") return fieldChoices[field.key] !== undefined && field.options.some((option) => !option.disabled && option.value === fieldChoices[field.key])
    if (isCheckboxField(field) || isRadioField(field)) return true
    return Boolean(fieldMappings[field.key])
  }) && controlsMapped
  const messageField = configuredFields[messageFieldIndex]
  const forwardedMappingReady = template !== "lead_form" || proofMode !== "forwarded_marker" || Boolean(messageField && isSyntheticTextField(messageField) && messageField.locator)
  const hasEmailMapping = supportedFields.some((field) => isSyntheticTextField(field) && field.key !== (template === "lead_form" && proofMode === "forwarded_marker" ? messageField?.key : "") && fieldMappings[field.key] === "email")
  const emailMappingReady = template === "trial_signup" || (template === "lead_form" && emailProof && proofMode === "autoresponse") ? hasEmailMapping : true
  const emailTimingReady = emailThresholdSeconds >= 5 && emailThresholdSeconds <= 3_600
    && emailMaximumWaitSeconds >= emailThresholdSeconds && emailMaximumWaitSeconds <= 3_600
  const leadSuccessReady = template !== "lead_form"
    || (successMode === "text" && Boolean(successText.trim()))
    || (successMode === "url" && Boolean(scan && isApprovedActionUrl(successUrl, scan.approvedActionDomains)))
    || (successMode === "visible_state" && Boolean(successStateRole.trim() && successStateName.trim()))
  const verificationRuleReady = template !== "trial_signup" || (
    verificationPathPrefix.startsWith("/")
    && !/[?#]/.test(verificationPathPrefix)
    && (!verificationQueryParameter.trim() || /^[A-Za-z0-9_.~-]+$/.test(verificationQueryParameter.trim()))
  )
  const trialConfigurationReady = template !== "trial_signup" || (
    Boolean(verificationHost && scan?.approvedActionDomains.includes(verificationHost))
    && verificationRuleReady
    && Boolean(accountStateText.trim())
    && (cleanupMode === "webhook" ? isApprovedActionUrl(cleanupWebhookUrl, scan?.approvedActionDomains ?? []) : Boolean(deleteButtonName.trim() && cleanupConfirmationText.trim()))
  )
  const builderReady = Boolean(scan && !scan.captchaDetected && scan.actions[actionIndex])
    && fieldsMapped
    && !unsupportedRequiredFields.length
    && !tooManySupportedFields
    && forwardedMappingReady
    && emailMappingReady
    && (template !== "trial_signup" && !emailProof ? true : emailTimingReady)
    && leadSuccessReady
    && trialConfigurationReady
  const previewStages = builderReady ? buildDraft().stages : []

  return (
    <EvalPage>
      <EvalBreadcrumbs items={[{ label: "Journeys", href: "/journeys" }, { label: existing ? "Edit journey" : "New journey" }]} />
      <PageHeading title={existing ? "Edit journey" : "Create a critical journey"} description="Template → safe page scan → field mapping → assertions → supervised run → schedule." />
      <div className="mb-5 flex gap-2 overflow-x-auto">{["Template & URL", "Field mapping", "Assertions & cleanup", "Supervised run", "Schedule & alerts"].map((label, index) => <button key={label} type="button" onClick={() => index <= step && setStep(index)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${index === step ? "bg-blue-600 text-white" : index < step ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>{index + 1}. {label}</button>)}</div>
      <form onSubmit={scanPage} className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Card className="rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader><CardTitle>{step === 0 ? "Choose the public journey" : step === 1 ? "Map the detected form" : step === 2 ? "Review deterministic assertions" : step === 3 ? "Run under supervision" : "Enable safe operations"}</CardTitle><CardDescription>{step === 0 ? "Legacy endpoints remain in endpoint monitoring; new browser evals use Lead form or Trial signup." : "Every action is explicit, allowlisted and backed by a public owner authorization."}</CardDescription></CardHeader>
          <CardContent>
            {step === 0 ? <FieldGroup><Field><FieldLabel htmlFor="journey-template">Launch template</FieldLabel><NativeSelect id="journey-template" value={template} disabled={Boolean(existing)} onChange={(event) => { const value = event.target.value as typeof template; setTemplate(value); setEmailProof(value === "trial_signup"); if (value === "lead_form") setSuccessText("Thank you") }}><NativeSelectOption value="lead_form">Lead form</NativeSelectOption><NativeSelectOption value="trial_signup">Trial signup</NativeSelectOption></NativeSelect></Field><Field><FieldLabel htmlFor="journey-name">Journey name</FieldLabel><Input id="journey-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field><FieldLabel htmlFor="journey-project">Project</FieldLabel><NativeSelect id="journey-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <NativeSelectOption key={project.id} value={project.id}>{project.name}</NativeSelectOption>)}</NativeSelect></Field><Field><FieldLabel htmlFor="journey-url">Public HTTPS start URL</FieldLabel><Input id="journey-url" type="url" value={startUrl} onChange={(event) => setStartUrl(event.target.value)} placeholder="https://example.com/signup" required /><FieldDescription>The project owner must authorize this domain before scanning.</FieldDescription></Field></FieldGroup> : null}
            {step === 1 && scan ? (
              <FieldGroup>
                <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-600">Scanned <strong>{scan.title || scan.url}</strong>. Map every supported form field to an approved run-specific value; arbitrary selectors and scripts are excluded.</div>
                <JourneyAiDraftReview
                  section="configuration"
                  draft={aiDraft}
                  loading={aiDraftLoading}
                  error={aiDraftError}
                  appliedSuggestionIds={appliedAiSuggestionIds}
                  onRequest={() => void requestAiDraft()}
                  onApply={applyAiSuggestion}
                />
                <div className="flex flex-col gap-3">
                  {configuredFields.filter((field) => !isRadioField(field)).map((field) => isSupportedFormField(field) ? (
                    <div key={field.key} className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-[1fr_220px] sm:items-end">
                      <span><span className="block text-sm font-medium text-slate-900">{field.label}{field.required ? " · required" : ""}</span><span className="mt-1 block text-xs text-slate-500">{field.control} · {field.inputType || "text"} · semantic {field.locator?.kind.replace("_", "-")}</span></span>
                      {field.control === "select" ? <Field><FieldLabel htmlFor={`choice-${field.key}`}>Published option</FieldLabel><NativeSelect id={`choice-${field.key}`} value={fieldChoices[field.key] ?? ""} onChange={(event) => setFieldChoices((current) => ({ ...current, [field.key]: event.target.value }))}>{field.options.filter((option) => !option.disabled).map((option) => <NativeSelectOption key={`${field.key}-${option.value}`} value={option.value}>{option.label || option.value || "Blank option"}</NativeSelectOption>)}</NativeSelect></Field>
                        : isCheckboxField(field) ? <Field><FieldLabel htmlFor={`checkbox-${field.key}`}>Operator decision</FieldLabel><NativeSelect id={`checkbox-${field.key}`} value={approvedCheckboxes[field.key] ? "check" : "leave"} onChange={(event) => setApprovedCheckboxes((current) => ({ ...current, [field.key]: event.target.value === "check" }))}><NativeSelectOption value="leave">Leave untouched (safe default)</NativeSelectOption><NativeSelectOption value="check">Check once — explicitly approved</NativeSelectOption></NativeSelect><FieldDescription>Maintain Flow never opts into marketing or SMS by default.{field.required ? " This required control needs your explicit approval." : " Leave it untouched unless it is necessary and authorized."}</FieldDescription></Field>
                          : <Field><FieldLabel htmlFor={`mapping-${field.key}`}>Synthetic value</FieldLabel><NativeSelect id={`mapping-${field.key}`} value={fieldMappings[field.key] ?? ""} onChange={(event) => setFieldMappings((current) => ({ ...current, [field.key]: event.target.value as SafeSyntheticValueKey }))}><NativeSelectOption value="">Choose value</NativeSelectOption>{safeSyntheticValueKeys.map((key) => <NativeSelectOption key={key} value={key}>{syntheticValueLabel(key)}</NativeSelectOption>)}</NativeSelect></Field>}
                    </div>
                  ) : <div key={field.key} className={`rounded-md border p-3 text-sm ${field.required ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}><span className="font-medium">{field.label}{field.required ? " · required" : ""}</span><span className="mt-1 block text-xs">{isPhoneLikeField(field) ? "Telephone and SMS fields are never populated, so a synthetic run cannot submit a dialable contact number." : `${field.control} / ${field.inputType || "unknown"} cannot be safely filled with the approved synthetic value set.`}{field.required ? " This journey cannot be published until the page exposes a supported semantic input." : " This optional control will be left untouched."}</span></div>)}
                  {radioGroups.map((group) => (
                    <div key={group.key} className={`grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_220px] sm:items-end ${group.required && group.ambiguous ? "border-red-200 bg-red-50" : "border-slate-200"}`}>
                      <span><span className="block text-sm font-medium text-slate-900">{group.name || "Unnamed radio group"}{group.required ? " · required" : ""}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{group.ambiguous ? "The scan could not prove which radio options belong together. Maintain Flow will leave them untouched." : "Choose at most one semantic option. No option is selected by default, including marketing or SMS consent."}</span></span>
                      {group.ambiguous ? <p className="text-xs leading-5 text-red-700">{group.required ? "A required unnamed radio group cannot be published safely." : "Optional ambiguous group left untouched."}</p> : <Field><FieldLabel htmlFor={`radio-${safeFieldKey(group.key)}`}>Operator-approved choice</FieldLabel><NativeSelect id={`radio-${safeFieldKey(group.key)}`} value={radioChoices[group.key] ?? ""} onChange={(event) => setRadioChoices((current) => ({ ...current, [group.key]: event.target.value }))}><NativeSelectOption value="">{group.required ? "Choose one required option" : "Leave group untouched (safe default)"}</NativeSelectOption>{group.fields.filter(isSupportedFormField).map((field) => <NativeSelectOption key={field.key} value={field.key}>{field.label}</NativeSelectOption>)}</NativeSelect><FieldDescription>Only this one approved option is compiled into the immutable manifest.</FieldDescription></Field>}
                    </div>
                  ))}
                </div>
                <Field><FieldLabel htmlFor="mapped-action">Single submit action</FieldLabel><NativeSelect id="mapped-action" value={String(actionIndex)} onChange={(event) => setActionIndex(Number(event.target.value))}>{scan.actions.map((action, index) => <NativeSelectOption key={action.key} value={String(index)}>{action.label}</NativeSelectOption>)}</NativeSelect></Field>
                {!emailMappingReady ? <p role="alert" className="text-sm text-red-700">This email proof mode requires one supported field mapped to the generated email value.</p> : null}
                {!supportedFields.some(isSyntheticTextField) ? <p role="alert" className="text-sm text-red-700">This journey needs at least one supported text field for marked synthetic data. Consent controls alone cannot form a safe submission.</p> : null}
                {tooManySupportedFields ? <p role="alert" className="text-sm text-red-700">This form exposes more than 29 supported fields, which exceeds the safe per-stage action limit. Narrow the public form before publishing.</p> : null}
                {scan.warnings.map((warning) => <p key={warning} className="text-sm text-amber-700">{warning}</p>)}
              </FieldGroup>
            ) : null}
            {step === 2 ? (
              <FieldGroup>
                <JourneyAiDraftReview
                  section="impact"
                  draft={aiDraft}
                  loading={aiDraftLoading}
                  error={aiDraftError}
                  appliedSuggestionIds={appliedAiSuggestionIds}
                  onRequest={() => void requestAiDraft()}
                  onApply={applyAiSuggestion}
                />
                {template === "lead_form" ? <LeadSuccessConfiguration
                  mode={successMode}
                  setMode={setSuccessMode}
                  successText={successText}
                  setSuccessText={setSuccessText}
                  successUrl={successUrl}
                  setSuccessUrl={setSuccessUrl}
                  successStateRole={successStateRole}
                  setSuccessStateRole={setSuccessStateRole}
                  successStateName={successStateName}
                  setSuccessStateName={setSuccessStateName}
                  approvedDomains={scan?.approvedActionDomains ?? []}
                /> : null}
                {template === "lead_form" ? (
                  <>
                    <label className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-4"><span><span className="block text-sm font-medium">Optional email proof</span><span className="mt-1 block text-xs text-slate-500">Prove that the submitted lead creates the expected notification.</span></span><Switch checked={emailProof} onCheckedChange={setEmailProof} /></label>
                    {emailProof ? (
                      <div className="rounded-lg border border-slate-200 p-4">
                        <p className="text-sm font-medium text-slate-950">How should email delivery be proven?</p>
                        <div className="mt-3 grid gap-2">
                          <ProofModeOption checked={proofMode === "autoresponse"} onChange={() => setProofMode("autoresponse")} title="Autoresponse to generated address" description="Use when the lead form sends a confirmation to the submitted run-specific email address." />
                          <ProofModeOption checked={proofMode === "forwarded_marker"} onChange={() => setProofMode("forwarded_marker")} title="Forwarded destination notification" description="Use when the site notifies its normal destination inbox and that message is forwarded into Maintain Flow." />
                        </div>
                        {proofMode === "forwarded_marker" ? (
                          <div className="mt-4 border-t border-slate-200 pt-4">
                            <Field><FieldLabel htmlFor="mapped-message-field">Marker message or notes field</FieldLabel><NativeSelect id="mapped-message-field" value={String(messageFieldIndex)} onChange={(event) => { const index = Number(event.target.value); setMessageFieldIndex(index); const field = scan?.fields[index]; if (field) setFieldMappings((current) => ({ ...current, [field.key]: "message" })) }}><NativeSelectOption value="-1">Choose a message field</NativeSelectOption>{scan?.fields.map((field, index) => isSyntheticTextField(field) ? <NativeSelectOption key={field.key} value={String(index)}>{field.label}{fieldMappings[field.key] === "email" ? " · currently mapped to email" : ""}</NativeSelectOption> : null)}</NativeSelect><FieldDescription>Maintain Flow fills this field with a safe synthetic message containing the exact MF-EVAL run marker before submitting.</FieldDescription></Field>
                            {!forwardedMappingReady ? <p role="alert" className="mt-2 text-sm text-red-700">Map a message or notes field that is different from the email field before publishing.</p> : null}
                            <p className="mt-3 rounded-md bg-blue-50 p-3 text-xs leading-5 text-blue-800">The destination notification must preserve the exact MF-EVAL marker when forwarded. An owner or admin can retrieve the stable forwarding address after this journey is published.</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : <TrialSignupConfiguration scan={scan} verificationHost={verificationHost} setVerificationHost={setVerificationHost} verificationPathPrefix={verificationPathPrefix} setVerificationPathPrefix={setVerificationPathPrefix} verificationRequiredText={verificationRequiredText} setVerificationRequiredText={setVerificationRequiredText} verificationQueryParameter={verificationQueryParameter} setVerificationQueryParameter={setVerificationQueryParameter} accountStateText={accountStateText} setAccountStateText={setAccountStateText} cleanupMode={cleanupMode} setCleanupMode={setCleanupMode} deleteButtonName={deleteButtonName} setDeleteButtonName={setDeleteButtonName} cleanupConfirmationText={cleanupConfirmationText} setCleanupConfirmationText={setCleanupConfirmationText} cleanupWebhookUrl={cleanupWebhookUrl} setCleanupWebhookUrl={setCleanupWebhookUrl} />}
                {(template === "trial_signup" || emailProof) ? <EmailTimingConfiguration thresholdSeconds={emailThresholdSeconds} setThresholdSeconds={setEmailThresholdSeconds} maximumWaitSeconds={emailMaximumWaitSeconds} setMaximumWaitSeconds={setEmailMaximumWaitSeconds} /> : null}
                <div className="flex flex-col gap-2">{previewStages.map((stage, index) => <div key={stage.key} className="rounded-md border border-slate-200 p-3"><p className="text-sm font-medium">{index + 1}. {stage.name}{stage.cleanup ? " · cleanup" : ""}</p><p className="mt-1 text-xs text-slate-500">{stage.expected}</p><p className="mt-2 text-xs leading-5 text-slate-600"><span className="font-medium text-slate-700">Business impact:</span> {stage.businessImpact}{businessImpactOverrides[stage.key] ? <span className="ml-1 text-blue-700">· AI draft applied</span> : null}</p></div>)}</div>
              </FieldGroup>
            ) : null}
            {step === 3 ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-5"><p className="font-medium text-slate-950">Published immutable journey version</p><p className="mt-2 text-sm leading-6 text-slate-600">Run it once under supervision. Scheduling remains locked until this run passes and required cleanup is verified.</p>{forwardingRecipient ? <div className="mt-4 rounded-md border border-blue-200 bg-white p-3"><p className="text-xs font-medium uppercase tracking-wide text-blue-700">Forward destination notifications here</p><div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center"><code className="min-w-0 flex-1 break-all text-sm text-slate-800">{forwardingRecipient}</code><Button type="button" variant="outline" size="sm" onClick={copyForwardingRecipient} className="shrink-0 rounded-md border-slate-200"><IconCopy data-icon="inline-start" />Copy</Button></div><p className="mt-2 text-xs leading-5 text-slate-500">Forward the destination notification without changing the exact MF-EVAL marker.</p><p aria-live="polite" className="mt-1 text-xs text-slate-500">{copyMessage}</p></div> : null}</div> : null}
            {step === 4 ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-5"><p className="font-medium text-slate-950">{supervisedPassed ? "Supervised proof passed" : supervisedFinished ? "Supervised proof needs attention" : "Supervised run in progress"}</p><p className="mt-2 text-sm leading-6 text-slate-600">Run {runId}. {supervisedPassed ? "The active immutable version is now eligible for a daily schedule." : supervisedFinished ? `The run finished ${supervisedRun?.status ?? "without proof"}. Fix the journey and publish a new version before scheduling.` : "Maintain Flow is polling the immutable run record. Scheduling stays locked until it passes and required cleanup is verified."}</p>{supervisedRun ? <div className="mt-3"><StatusLabel status={supervisedRun.status} compact /></div> : null}</div> : null}
          </CardContent>
        </Card>
        <Card className="h-fit rounded-lg border border-slate-200 bg-white shadow-none ring-0">
          <CardHeader><CardTitle>Next action</CardTitle><CardDescription>Maintain Flow will not skip a safety gate.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
            {step === 0 ? <Button type="submit" disabled={saving} className="w-full rounded-md bg-blue-600 hover:bg-blue-700">{saving ? "Scanning…" : "Scan public page"}</Button> : null}
            {step === 1 ? <Button type="button" onClick={() => setStep(2)} disabled={!fieldsMapped || Boolean(unsupportedRequiredFields.length) || tooManySupportedFields || !scan?.actions.length || !emailMappingReady} className="w-full rounded-md bg-blue-600 hover:bg-blue-700">Review assertions</Button> : null}
            {step === 2 ? <Button type="button" onClick={saveAndPublish} disabled={saving || !builderReady} className="w-full rounded-md bg-blue-600 hover:bg-blue-700">{saving ? "Publishing…" : "Save and publish version"}</Button> : null}
            {step === 3 ? <Button type="button" onClick={startSupervisedRun} disabled={saving} className="w-full rounded-md bg-blue-600 hover:bg-blue-700">{saving ? "Queueing…" : "Start supervised run"}</Button> : null}
            {step === 4 ? <><Button type="button" onClick={enableSchedule} disabled={saving || !supervisedPassed} className="w-full rounded-md bg-blue-600 hover:bg-blue-700">{saving ? "Checking…" : supervisedPassed ? "Enable daily schedule" : "Schedule locked"}</Button><Button nativeButton={false} render={<Link href="/settings/alerts" />} variant="outline" className="w-full rounded-md border-slate-200">Configure alerts</Button><Button nativeButton={false} render={<Link href={`/eval-runs/${runId}`} />} variant="outline" className="w-full rounded-md border-slate-200">Open supervised run</Button></> : null}
            {step > 0 && step < 3 ? <Button type="button" variant="outline" onClick={() => setStep((current) => Math.max(0, current - 1))} className="w-full rounded-md border-slate-200">Back</Button> : null}
            <Button type="button" variant="outline" onClick={() => router.back()} className="w-full rounded-md border-slate-200">Cancel</Button>
          </CardContent>
        </Card>
      </form>
    </EvalPage>
  )
}

function LeadSuccessConfiguration({
  mode,
  setMode,
  successText,
  setSuccessText,
  successUrl,
  setSuccessUrl,
  successStateRole,
  setSuccessStateRole,
  successStateName,
  setSuccessStateName,
  approvedDomains,
}: {
  mode: "text" | "url" | "visible_state"
  setMode: (value: "text" | "url" | "visible_state") => void
  successText: string
  setSuccessText: (value: string) => void
  successUrl: string
  setSuccessUrl: (value: string) => void
  successStateRole: string
  setSuccessStateRole: (value: string) => void
  successStateName: string
  setSuccessStateName: (value: string) => void
  approvedDomains: string[]
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium text-slate-950">Deterministic lead success</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">Choose the one observable state that proves the single synthetic submission was accepted.</p>
      <Field className="mt-4"><FieldLabel htmlFor="lead-success-mode">Success assertion</FieldLabel><NativeSelect id="lead-success-mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><NativeSelectOption value="text">Thank-you text</NativeSelectOption><NativeSelectOption value="url">Exact success URL</NativeSelectOption><NativeSelectOption value="visible_state">Accessible form state</NativeSelectOption></NativeSelect></Field>
      {mode === "text" ? <Field className="mt-4"><FieldLabel htmlFor="success-text">Expected thank-you text</FieldLabel><Input id="success-text" value={successText} onChange={(event) => setSuccessText(event.target.value)} /><FieldDescription>The visible text must match once and appears only after submission.</FieldDescription></Field> : null}
      {mode === "url" ? <Field className="mt-4"><FieldLabel htmlFor="success-url">Exact public HTTPS success URL</FieldLabel><Input id="success-url" type="url" value={successUrl} onChange={(event) => setSuccessUrl(event.target.value)} placeholder="https://example.com/thanks" /><FieldDescription>The URL must use a host covered by the project owner authorization.</FieldDescription>{successUrl && !isApprovedActionUrl(successUrl, approvedDomains) ? <p role="alert" className="mt-1 text-xs text-red-700">Use an HTTPS URL on an explicitly approved action domain.</p> : null}</Field> : null}
      {mode === "visible_state" ? <div className="mt-4 grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="success-state-role">Accessible role</FieldLabel><NativeSelect id="success-state-role" value={successStateRole} onChange={(event) => setSuccessStateRole(event.target.value)}><NativeSelectOption value="status">Status</NativeSelectOption><NativeSelectOption value="alert">Alert</NativeSelectOption><NativeSelectOption value="heading">Heading</NativeSelectOption><NativeSelectOption value="region">Region</NativeSelectOption></NativeSelect><FieldDescription>A semantic role, never CSS or XPath.</FieldDescription></Field><Field><FieldLabel htmlFor="success-state-name">Accessible name</FieldLabel><Input id="success-state-name" value={successStateName} onChange={(event) => setSuccessStateName(event.target.value)} placeholder="Lead received" /><FieldDescription>The state must match exactly one visible element.</FieldDescription></Field></div> : null}
    </div>
  )
}

function EmailTimingConfiguration({
  thresholdSeconds,
  setThresholdSeconds,
  maximumWaitSeconds,
  setMaximumWaitSeconds,
}: {
  thresholdSeconds: number
  setThresholdSeconds: (value: number) => void
  maximumWaitSeconds: number
  setMaximumWaitSeconds: (value: number) => void
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium text-slate-950">Email timing contract</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">Arrival by the target passes. Arrival after the target but before the maximum is degraded. Only the final maximum can time out.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field><FieldLabel htmlFor="email-target-seconds">Target arrival (seconds)</FieldLabel><Input id="email-target-seconds" type="number" min={5} max={3600} value={thresholdSeconds} onChange={(event) => setThresholdSeconds(Number(event.target.value))} /><FieldDescription>Approved degraded boundary.</FieldDescription></Field>
        <Field><FieldLabel htmlFor="email-max-wait-seconds">Maximum wait (seconds)</FieldLabel><Input id="email-max-wait-seconds" type="number" min={Math.max(5, thresholdSeconds)} max={3600} value={maximumWaitSeconds} onChange={(event) => setMaximumWaitSeconds(Number(event.target.value))} /><FieldDescription>Final timeout; defaults to 600 seconds.</FieldDescription></Field>
      </div>
      {maximumWaitSeconds < thresholdSeconds ? <p role="alert" className="mt-2 text-xs text-red-700">Maximum wait must be at least the target arrival time.</p> : null}
    </div>
  )
}

function TrialSignupConfiguration({
  scan,
  verificationHost,
  setVerificationHost,
  verificationPathPrefix,
  setVerificationPathPrefix,
  verificationRequiredText,
  setVerificationRequiredText,
  verificationQueryParameter,
  setVerificationQueryParameter,
  accountStateText,
  setAccountStateText,
  cleanupMode,
  setCleanupMode,
  deleteButtonName,
  setDeleteButtonName,
  cleanupConfirmationText,
  setCleanupConfirmationText,
  cleanupWebhookUrl,
  setCleanupWebhookUrl,
}: {
  scan: ScanResult | null
  verificationHost: string
  setVerificationHost: (value: string) => void
  verificationPathPrefix: string
  setVerificationPathPrefix: (value: string) => void
  verificationRequiredText: string
  setVerificationRequiredText: (value: string) => void
  verificationQueryParameter: string
  setVerificationQueryParameter: (value: string) => void
  accountStateText: string
  setAccountStateText: (value: string) => void
  cleanupMode: "in_product" | "webhook"
  setCleanupMode: (value: "in_product" | "webhook") => void
  deleteButtonName: string
  setDeleteButtonName: (value: string) => void
  cleanupConfirmationText: string
  setCleanupConfirmationText: (value: string) => void
  cleanupWebhookUrl: string
  setCleanupWebhookUrl: (value: string) => void
}) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4">
      <p className="text-sm font-medium text-blue-950">Trial signup proof and cleanup</p>
      <p className="mt-1 text-xs leading-5 text-blue-800">Trial signup submits the generated email and opens a link only when one candidate matches the published host and path rule.</p>
      <div className="mt-4 grid gap-4">
        <Field><FieldLabel htmlFor="verification-host">Verification-link host</FieldLabel><NativeSelect id="verification-host" value={verificationHost} onChange={(event) => setVerificationHost(event.target.value)}><NativeSelectOption value="">Choose an approved host</NativeSelectOption>{scan?.approvedActionDomains.map((host) => <NativeSelectOption key={host} value={host}>{host}</NativeSelectOption>)}</NativeSelect><FieldDescription>Only hosts recorded in the project owner authorization can be opened from the verification email.</FieldDescription></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel htmlFor="verification-path">Required path prefix</FieldLabel><Input id="verification-path" value={verificationPathPrefix} onChange={(event) => setVerificationPathPrefix(event.target.value)} placeholder="/verify" /><FieldDescription>Required; no query or fragment.</FieldDescription></Field>
          <Field><FieldLabel htmlFor="verification-link-text">Required link text</FieldLabel><Input id="verification-link-text" value={verificationRequiredText} onChange={(event) => setVerificationRequiredText(event.target.value)} placeholder="Verify email" /><FieldDescription>Optional accessible anchor text.</FieldDescription></Field>
          <Field><FieldLabel htmlFor="verification-query-property">Required query property</FieldLabel><Input id="verification-query-property" value={verificationQueryParameter} onChange={(event) => setVerificationQueryParameter(event.target.value)} placeholder="token" /><FieldDescription>Name only; token values are never configured.</FieldDescription></Field>
        </div>
        {!verificationPathPrefix.startsWith("/") || /[?#]/.test(verificationPathPrefix) ? <p role="alert" className="text-xs text-red-700">Use a path beginning with / and exclude query strings or fragments.</p> : null}
        {verificationQueryParameter.trim() && !/^[A-Za-z0-9_.~-]+$/.test(verificationQueryParameter.trim()) ? <p role="alert" className="text-xs text-red-700">The query property must be a parameter name, not a token or value.</p> : null}
        <Field><FieldLabel htmlFor="account-state-text">Expected account or workspace state</FieldLabel><Input id="account-state-text" value={accountStateText} onChange={(event) => setAccountStateText(event.target.value)} placeholder="Your workspace is ready" /><FieldDescription>Visible text that deterministically proves the verified account reached its expected state.</FieldDescription></Field>
        <div>
          <p className="text-sm font-medium text-slate-950">Deterministic cleanup</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${cleanupMode === "in_product" ? "border-blue-300 bg-white" : "border-slate-200 bg-white/60"}`}><input type="radio" name="trial-cleanup-mode" checked={cleanupMode === "in_product"} onChange={() => setCleanupMode("in_product")} className="mt-1" /><span><span className="block text-sm font-medium">In-product delete</span><span className="mt-1 block text-xs leading-5 text-slate-500">Use one semantic delete button and prove its confirmation.</span></span></label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${cleanupMode === "webhook" ? "border-blue-300 bg-white" : "border-slate-200 bg-white/60"}`}><input type="radio" name="trial-cleanup-mode" checked={cleanupMode === "webhook"} onChange={() => setCleanupMode("webhook")} className="mt-1" /><span><span className="block text-sm font-medium">Cleanup webhook</span><span className="mt-1 block text-xs leading-5 text-slate-500">Use an approved idempotent HTTPS cleanup endpoint.</span></span></label>
          </div>
        </div>
        {cleanupMode === "in_product" ? <div className="grid gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="delete-button-name">Delete button accessible name</FieldLabel><Input id="delete-button-name" value={deleteButtonName} onChange={(event) => setDeleteButtonName(event.target.value)} placeholder="Delete test account" /><FieldDescription>A semantic button name, never a CSS selector.</FieldDescription></Field><Field><FieldLabel htmlFor="cleanup-confirmation">Deletion confirmation text</FieldLabel><Input id="cleanup-confirmation" value={cleanupConfirmationText} onChange={(event) => setCleanupConfirmationText(event.target.value)} placeholder="Account deleted" /><FieldDescription>Visible text required after the delete action.</FieldDescription></Field></div> : <Field><FieldLabel htmlFor="cleanup-webhook">Approved idempotent cleanup webhook</FieldLabel><Input id="cleanup-webhook" type="url" value={cleanupWebhookUrl} onChange={(event) => setCleanupWebhookUrl(event.target.value)} placeholder="https://example.com/evals/cleanup" /><FieldDescription>The endpoint must be public HTTPS on a host covered by the project authorization, reject unsafe destinations and return the same safe result when retried.</FieldDescription>{cleanupWebhookUrl && !isApprovedActionUrl(cleanupWebhookUrl, scan?.approvedActionDomains ?? []) ? <p role="alert" className="mt-1 text-xs text-red-700">Use an HTTPS URL on a host covered by the project owner authorization.</p> : null}</Field>}
      </div>
    </div>
  )
}

function ProofModeOption({ checked, onChange, title, description }: { checked: boolean; onChange: () => void; title: string; description: string }) {
  return <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${checked ? "border-blue-300 bg-blue-50" : "border-slate-200"}`}><input type="radio" name="lead-email-proof-mode" checked={checked} onChange={onChange} className="mt-1" /><span><span className="block text-sm font-medium text-slate-900">{title}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></span></label>
}

function existingLeadProofMode(draft: JourneyDraft | undefined) {
  for (const stage of draft?.stages ?? []) {
    const wait = stage.actions.find((action) => action.type === "wait_for_email")
    if (wait?.type === "wait_for_email") return wait.proofMode
  }
  return undefined
}

function syntheticValueLabel(key: SafeSyntheticValueKey) {
  const labels: Record<SafeSyntheticValueKey, string> = {
    first_name: "Synthetic first name",
    last_name: "Synthetic last name",
    full_name: "Synthetic full name",
    name: "Synthetic name",
    email: "Generated run email",
    company: "Synthetic company",
    workspace: "Synthetic workspace",
    message: "MF-EVAL marker message",
    password: "Generated test password",
    number: "Generated synthetic number",
    url: "Generated synthetic URL",
    marker: "MF-EVAL marker",
  }
  return labels[key]
}

function isHttpsUrl(value: string) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

function isApprovedActionUrl(value: string, approvedDomains: string[]) {
  if (!isHttpsUrl(value)) return false
  const hostname = new URL(value).hostname.toLowerCase()
  return approvedDomains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))
}

function existingStageText(draft: JourneyDraft | undefined, stageKey: string) {
  const stage = draft?.stages.find((item) => item.key === stageKey)
  const action = stage?.actions.find((item) => item.type === "wait_for_text")
  return action?.type === "wait_for_text" ? action.text : undefined
}

function existingVerificationHost(draft: JourneyDraft | undefined) {
  for (const stage of draft?.stages ?? []) {
    const action = stage.actions.find((item) => item.type === "open_email_link")
    if (action?.type === "open_email_link") return action.allowedHosts[0]
  }
  return undefined
}

function existingVerificationRule(draft: JourneyDraft | undefined) {
  for (const stage of draft?.stages ?? []) {
    const action = stage.actions.find((item) => item.type === "open_email_link")
    if (action?.type === "open_email_link") return action.linkRule
  }
  return undefined
}

function existingEmailTiming(draft: JourneyDraft | undefined) {
  for (const stage of draft?.stages ?? []) {
    const action = stage.actions.find((item) => item.type === "wait_for_email")
    if (action?.type === "wait_for_email") {
      return {
        thresholdSeconds: action.thresholdSeconds,
        maximumWaitSeconds: action.maximumWaitSeconds ?? Math.max(action.thresholdSeconds, 600),
      }
    }
  }
  return { thresholdSeconds: 120, maximumWaitSeconds: 600 }
}

function existingLeadSuccessMode(draft: JourneyDraft | undefined): "text" | "url" | "visible_state" {
  const action = draft?.stages.find((stage) => stage.key === "success_confirmed")?.actions[0]
  if (action?.type === "wait_for_url") return "url"
  if (action?.type === "assert_visible") return "visible_state"
  return "text"
}

function existingLeadSuccessUrl(draft: JourneyDraft | undefined) {
  const action = draft?.stages.find((stage) => stage.key === "success_confirmed")?.actions.find((item) => item.type === "wait_for_url")
  return action?.type === "wait_for_url" ? action.urlPattern : undefined
}

function existingLeadSuccessLocator(draft: JourneyDraft | undefined) {
  const action = draft?.stages.find((stage) => stage.key === "success_confirmed")?.actions.find((item) => item.type === "assert_visible")
  return action?.type === "assert_visible" && action.locator.kind === "role" ? action.locator : undefined
}

function withFieldLocatorOverrides(
  fields: ScanResult["fields"],
  overrides: Record<string, AiDraftFieldLocator>,
) {
  return fields.map((field) => ({
    ...field,
    locator: overrides[field.key] ?? field.locator,
  }))
}

function locatorSummary(locator: AiDraftFieldLocator | AiDraftSubmitLocator) {
  return locator.kind === "role"
    ? `role ${locator.role} named “${locator.name}”`
    : `${locator.kind.replaceAll("_", "-")} “${locator.value}”`
}

function safeFieldKey(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_")
}

function journeyCoverageLabel(journey: ReturnType<typeof useEvals>["journeys"][number]) {
  if (journey.template === "legacy_endpoint") return "Legacy endpoint"
  if (journey.template === "trial_signup") return "Browser + email + cleanup"
  if (journey.rawDraft?.emailProofConfigured) return "Browser + email"
  return "Browser only"
}

function previewJourneyScan(startUrl: string, template: "lead_form" | "trial_signup"): ScanResult {
  const parsed = new URL(startUrl)
  const fields: ScanResult["fields"] = template === "lead_form"
    ? [
        previewTextField("full-name", "Full name", "name", "text", true),
        previewTextField("work-email", "Work email", "email", "email", true),
        previewTextField("company", "Company", "company", "text", true),
        { ...previewTextField("message", "How can we help?", "message", "textarea", false), control: "textarea" },
      ]
    : [
        previewTextField("full-name", "Full name", "name", "text", true),
        previewTextField("work-email", "Work email", "email", "email", true),
        previewTextField("workspace", "Workspace name", "workspace", "text", true),
        previewTextField("password", "Password", "password", "password", true),
        previewTextField("eval-marker", "Eval marker", "marker", "text", true),
      ]

  return {
    url: parsed.toString(),
    title: template === "lead_form" ? "Controlled lead form" : "Controlled trial signup",
    captchaDetected: false,
    fields,
    actions: [{
      key: "submit",
      label: template === "lead_form" ? "Submit lead" : "Start trial",
      locator: { kind: "role", role: "button", name: template === "lead_form" ? "Submit lead" : "Start trial" },
    }],
    warnings: [],
    approvedActionDomains: [parsed.hostname],
  }
}

function previewTextField(
  key: string,
  label: string,
  name: string,
  inputType: string,
  required: boolean,
): ScanResult["fields"][number] {
  return {
    key,
    control: "input",
    inputType,
    label,
    name,
    required,
    options: [],
    locator: { kind: "label", value: label },
  }
}

function existingCleanupMode(draft: JourneyDraft | undefined): "in_product" | "webhook" {
  return draft?.cleanupMode === "webhook" ? "webhook" : "in_product"
}

function existingCleanupButton(draft: JourneyDraft | undefined) {
  for (const stage of draft?.stages ?? []) {
    const action = stage.actions.find((item) => item.type === "cleanup" && item.mode === "in_product")
    if (action?.type === "cleanup" && action.mode === "in_product" && action.locator?.kind === "role") return action.locator.name
  }
  return undefined
}

function existingCleanupConfirmation(draft: JourneyDraft | undefined) {
  const stage = draft?.stages.find((item) => item.cleanup)
  const action = stage?.actions.find((item) => item.type === "wait_for_text")
  return action?.type === "wait_for_text" ? action.text : undefined
}

function existingCleanupWebhook(draft: JourneyDraft | undefined) {
  for (const stage of draft?.stages ?? []) {
    const action = stage.actions.find((item) => item.type === "cleanup" && item.mode === "webhook")
    if (action?.type === "cleanup" && action.mode === "webhook") return action.webhookUrl
  }
  return undefined
}
