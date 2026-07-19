import { z } from "zod"

export const uuidSchema = z.string().uuid()
export const idempotencyKeySchema = z.string().trim().min(8).max(200)
const publicHostnamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

const hostnameSchema = z.string().trim().min(1).max(253).transform((value) => value.toLowerCase()).refine((value) => {
  try {
    const url = new URL(`https://${value}`)
    return url.hostname === value
      && publicHostnamePattern.test(value)
      && !/^\d+(?:\.\d+){3}$/.test(value)
      && !isReservedPrivateHostname(value)
  } catch {
    return false
  }
}, "A valid public hostname is required.")

function isReservedPrivateHostname(value: string) {
  return ["localhost", "local", "internal", "home.arpa"].some((suffix) => value === suffix || value.endsWith(`.${suffix}`))
    || value === "metadata.google.internal"
}

export const pageQuerySchema = z.object({
  cursor: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
})

export const includeArchivedQuerySchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true")

export const projectKindSchema = z.enum(["own_product", "client_site", "personal"])
export const journeyTemplateSchema = z.enum(["lead_form", "trial_signup", "legacy_endpoint"])
export const evalVerdictSchema = z.enum([
  "passed",
  "degraded",
  "failed",
  "inconclusive",
  "cancelled",
])
export const stageVerdictSchema = z.union([evalVerdictSchema, z.literal("not_run")])

const httpsUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      context.addIssue({ code: "custom", message: "A valid public HTTPS URL is required." })
      return z.NEVER
    }
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || !publicHostnamePattern.test(hostname)
      || /^\d+(?:\.\d+){3}$/.test(hostname)
      || isReservedPrivateHostname(hostname)
    ) {
      context.addIssue({ code: "custom", message: "Only public HTTPS URLs without embedded credentials are supported." })
      return z.NEVER
    }
    url.hostname = hostname
    const normalized = url.toString()
    if (normalized.length > 2_048) {
      context.addIssue({ code: "custom", message: "The normalized URL must be at most 2048 characters." })
      return z.NEVER
    }
    return normalized
  })

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  website: httpsUrlSchema,
  kind: projectKindSchema,
  ownerUserId: uuidSchema.optional(),
  reportRecipientEmail: z.string().trim().email().max(320).optional().or(z.literal("")),
  notes: z.string().trim().max(4_000).optional().default(""),
})

export const updateProjectSchema = createProjectSchema.partial().extend({
  archived: z.boolean().optional(),
})

export const projectAuthorizationSchema = z.object({
  projectId: uuidSchema,
  domain: hostnameSchema,
  attestationVersion: z.literal("2026-07-18"),
  attested: z.literal(true),
  approvedActionDomains: z.array(hostnameSchema).max(20).default([]),
})

export const journeyScanSchema = z.object({
  projectId: uuidSchema,
  url: httpsUrlSchema,
  template: z.enum(["lead_form", "trial_signup"]),
})

export const locatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("label"), value: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("placeholder"), value: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal("text"), value: z.string().trim().min(1).max(200), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal("test_id"), value: z.string().trim().min(1).max(200) }),
])

const actionBaseSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  timeoutMs: z.number().int().min(250).max(60_000).default(10_000),
})

export const verificationLinkRuleSchema = z.object({
  host: hostnameSchema,
  pathPrefix: z.string().trim().min(1).max(500).refine(
    (value) => value.startsWith("/") && !/[?#]/.test(value),
    "Use a URL path prefix without a query string or fragment."
  ),
  requiredText: z.string().trim().min(1).max(200).optional(),
  requiredQueryParameter: z.string().trim().min(1).max(100).regex(
    /^[A-Za-z0-9_.~-]+$/,
    "Use a query-parameter name, not a value."
  ).optional(),
})

const textFillActionSchema = actionBaseSchema.extend({
  type: z.literal("fill"),
  operation: z.literal("text").default("text"),
  locator: locatorSchema,
  valueKey: z.string().trim().min(1).max(80),
})

const selectFillActionSchema = actionBaseSchema.extend({
  type: z.literal("fill"),
  operation: z.literal("select"),
  locator: locatorSchema,
  optionValue: z.string().max(500),
})

const checkFillActionSchema = actionBaseSchema.extend({
  type: z.literal("fill"),
  operation: z.literal("check"),
  locator: locatorSchema,
  expectedChecked: z.literal(true),
  operatorApproved: z.literal(true),
  controlKind: z.enum(["checkbox", "radio"]),
  radioGroup: z.string().trim().min(1).max(200).optional(),
}).superRefine((action, context) => {
  if (action.controlKind === "radio" && !action.radioGroup) {
    context.addIssue({ code: "custom", path: ["radioGroup"], message: "Radio controls require one semantic group name." })
  }
  if (action.controlKind === "checkbox" && action.radioGroup) {
    context.addIssue({ code: "custom", path: ["radioGroup"], message: "Checkbox controls cannot declare a radio group." })
  }
})

const cleanupActionSchema = actionBaseSchema.extend({
  type: z.literal("cleanup"),
  mode: z.enum(["in_product", "webhook"]),
  locator: locatorSchema.optional(),
  webhookUrl: httpsUrlSchema.optional(),
}).superRefine((action, context) => {
  if (action.mode === "in_product") {
    if (!action.locator) {
      context.addIssue({ code: "custom", path: ["locator"], message: "In-product cleanup requires an approved semantic locator." })
    }
    if (action.webhookUrl) {
      context.addIssue({ code: "custom", path: ["webhookUrl"], message: "In-product cleanup cannot declare a webhook URL." })
    }
  } else {
    if (!action.webhookUrl) {
      context.addIssue({ code: "custom", path: ["webhookUrl"], message: "Webhook cleanup requires a public HTTPS URL." })
    }
    if (action.locator) {
      context.addIssue({ code: "custom", path: ["locator"], message: "Webhook cleanup cannot declare a browser locator." })
    }
  }
})

export const restrictedActionSchema = z.union([
  actionBaseSchema.extend({ type: z.literal("navigate"), url: httpsUrlSchema }),
  textFillActionSchema,
  selectFillActionSchema,
  checkFillActionSchema,
  actionBaseSchema.extend({ type: z.literal("click"), locator: locatorSchema }),
  actionBaseSchema.extend({ type: z.literal("wait_for_url"), urlPattern: z.string().trim().min(1).max(500) }),
  actionBaseSchema.extend({ type: z.literal("wait_for_text"), text: z.string().trim().min(1).max(500) }),
  actionBaseSchema.extend({
    type: z.literal("wait_for_email"),
    recipientKey: z.enum(["email", "forwarding"]),
    proofMode: z.enum(["autoresponse", "forwarded_marker"]).default("autoresponse"),
    thresholdSeconds: z.number().int().min(5).max(3_600),
    maximumWaitSeconds: z.number().int().min(5).max(3_600).default(600),
  }),
  actionBaseSchema.extend({
    type: z.literal("open_email_link"),
    allowedHosts: z.array(hostnameSchema).min(1).max(20),
    linkRule: verificationLinkRuleSchema,
  }),
  actionBaseSchema.extend({ type: z.literal("assert_visible"), locator: locatorSchema }),
  cleanupActionSchema,
])

export const journeyStageDraftSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/, "Stage keys must use lowercase letters, numbers, or underscores and start with a letter."),
  name: z.string().trim().min(1).max(120),
  position: z.number().int().min(0).max(30),
  required: z.boolean().default(true),
  cleanup: z.boolean().default(false),
  actions: z.array(restrictedActionSchema).min(1).max(30),
  expected: z.string().trim().min(1).max(1_000),
  businessImpact: z.string().trim().max(1_000).default(""),
  timingThresholdMs: z.number().int().min(1).max(120_000).nullable().optional().default(null),
})

export const journeyDraftSchema = z.object({
  projectId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  template: z.enum(["lead_form", "trial_signup"]),
  startUrl: httpsUrlSchema,
  draftRevision: z.number().int().min(0),
  stages: z.array(journeyStageDraftSchema).min(1).max(30),
  emailProofConfigured: z.boolean().default(false),
  cleanupMode: z.enum(["none", "in_product", "webhook"]).default("none"),
}).superRefine((draft, context) => {
  const keys = new Set<string>()
  const positions = new Set<number>()
  for (const [index, stage] of draft.stages.entries()) {
    if (keys.has(stage.key)) context.addIssue({ code: "custom", path: ["stages", index, "key"], message: "Stage keys must be unique." })
    if (positions.has(stage.position)) context.addIssue({ code: "custom", path: ["stages", index, "position"], message: "Stage positions must be unique." })
    keys.add(stage.key)
    positions.add(stage.position)
  }
  const cleanupStages = draft.stages.filter((stage) => stage.cleanup)
  const orderedActions = [...draft.stages]
    .sort((left, right) => left.position - right.position)
    .flatMap((stage) => stage.actions.map((action, actionIndex) => ({
      action,
      cleanupStage: stage.cleanup,
      sequence: stage.position * 100 + actionIndex + 1,
    })))
  const actionsOfType = <T extends RestrictedAction["type"]>(type: T) =>
    orderedActions.filter((item) => item.action.type === type)
  const navigations = actionsOfType("navigate")
  const fills = actionsOfType("fill")
  const syntheticFills = fills.filter((item) => item.action.type === "fill" && item.action.operation === "text")
  const clicks = actionsOfType("click")
  const emailWaits = actionsOfType("wait_for_email")
  const emailLinks = actionsOfType("open_email_link")
  const cleanupActions = actionsOfType("cleanup")
  const businessOutcomeAssertions = orderedActions.filter((item) =>
    !item.cleanupStage && ["wait_for_url", "wait_for_text", "assert_visible"].includes(item.action.type)
  )
  const cleanupConfirmations = orderedActions.filter((item) =>
    item.cleanupStage && ["wait_for_url", "wait_for_text", "assert_visible"].includes(item.action.type)
  )
  const submitSequence = clicks[0]?.sequence ?? Number.POSITIVE_INFINITY
  const syntheticValueKeys = new Set([
    "marker", "first_name", "last_name", "full_name", "name", "email",
    "company", "workspace", "message", "password", "number", "url",
  ])
  const selectedRadioGroups = new Set<string>()
  for (const item of fills) {
    if (item.action.type !== "fill" || item.action.operation !== "check" || item.action.controlKind !== "radio") continue
    if (!item.action.radioGroup || selectedRadioGroups.has(item.action.radioGroup)) {
      context.addIssue({ code: "custom", path: ["stages"], message: "A published journey may select only one operator-approved option per semantic radio group." })
    } else {
      selectedRadioGroups.add(item.action.radioGroup)
    }
  }

  if (navigations.length !== 1) {
    context.addIssue({ code: "custom", path: ["stages"], message: "Each template requires exactly one opening navigation." })
  }
  if (syntheticFills.length < 1 || syntheticFills.some((item) => item.action.type === "fill" && item.action.operation === "text" && !syntheticValueKeys.has(item.action.valueKey))) {
    context.addIssue({ code: "custom", path: ["stages"], message: "The journey must fill at least one field using an approved synthetic value." })
  }
  if (clicks.length !== 1) {
    context.addIssue({ code: "custom", path: ["stages"], message: "The journey requires exactly one customer-visible submit action." })
  }
  if (
    navigations[0] && fills[0] && clicks[0]
    && !(navigations[0].sequence < fills[0].sequence
      && Math.max(...fills.map((item) => item.sequence)) < clicks[0].sequence)
  ) {
    context.addIssue({ code: "custom", path: ["stages"], message: "Open the page, fill synthetic fields, then submit exactly once." })
  }
  if (!businessOutcomeAssertions.some((item) => item.sequence > submitSequence)) {
    context.addIssue({ code: "custom", path: ["stages"], message: "A URL, text, or visible-state business assertion must run after submission." })
  }
  if (emailWaits.some((item) => item.action.type === "wait_for_email" && (
    (item.action.proofMode === "autoresponse" && item.action.recipientKey !== "email")
    || (item.action.proofMode === "forwarded_marker" && item.action.recipientKey !== "forwarding")
  ))) {
    context.addIssue({ code: "custom", path: ["stages"], message: "Email proof routing must match its configured proof mode." })
  }
  if (emailWaits.some((item) => item.action.type === "wait_for_email" && item.action.maximumWaitSeconds < item.action.thresholdSeconds)) {
    context.addIssue({ code: "custom", path: ["stages"], message: "Email proof maximum wait must be greater than or equal to its approved degraded threshold." })
  }
  if (
    emailWaits.some((item) => item.action.type === "wait_for_email" && item.action.proofMode === "autoresponse")
    && !syntheticFills.some((item) => item.action.type === "fill" && item.action.operation === "text" && item.action.valueKey === "email")
  ) {
    context.addIssue({ code: "custom", path: ["stages"], message: "Autoresponse proof must submit the generated run-specific email address." })
  }
  if (draft.template === "trial_signup") {
    if (draft.cleanupMode === "none" || cleanupStages.length !== 1) {
      context.addIssue({ code: "custom", path: ["cleanupMode"], message: "Trial signup requires exactly one cleanup stage." })
    }
    if (emailWaits.length !== 1 || emailLinks.length !== 1) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Trial signup requires one email wait and one allowlisted verification-link action." })
    }
    for (const item of emailLinks) {
      const action = item.action
      if (action.type !== "open_email_link") continue
      const ruleHost = action.linkRule.host
      const hostCovered = action.allowedHosts.some((host) => ruleHost === host || ruleHost.endsWith(`.${host}`))
      if (!hostCovered) {
        context.addIssue({ code: "custom", path: ["stages"], message: "The verification-link rule host must be covered by its published host allowlist." })
      }
    }
    if (emailWaits.some((item) => item.action.type === "wait_for_email" && item.action.proofMode !== "autoresponse")) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Trial signup verification must use the generated run-specific email address." })
    }
    if (!syntheticFills.some((item) => item.action.type === "fill" && item.action.operation === "text" && item.action.valueKey === "email")) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Trial signup must submit the generated test email identity." })
    }
    const emailSequence = emailWaits[0]?.sequence ?? Number.POSITIVE_INFINITY
    const linkSequence = emailLinks[0]?.sequence ?? Number.POSITIVE_INFINITY
    const finalAssertionSequence = Math.max(...businessOutcomeAssertions.map((item) => item.sequence), Number.NEGATIVE_INFINITY)
    const cleanupSequence = cleanupActions[0]?.sequence ?? Number.NEGATIVE_INFINITY
    if (!(submitSequence < emailSequence && emailSequence < linkSequence && linkSequence < finalAssertionSequence && finalAssertionSequence < cleanupSequence)) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Trial signup must submit, verify email, prove account state, then clean up in that order." })
    }
    if (cleanupActions.length !== 1) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Trial signup requires exactly one deterministic cleanup action." })
    }
    if (draft.cleanupMode === "in_product") {
      const firstConfirmation = Math.min(...cleanupConfirmations.map((item) => item.sequence), Number.POSITIVE_INFINITY)
      const lastConfirmation = Math.max(...cleanupConfirmations.map((item) => item.sequence), Number.NEGATIVE_INFINITY)
      const finalAction = Math.max(...orderedActions.map((item) => item.sequence), Number.NEGATIVE_INFINITY)
      if (!cleanupConfirmations.length || !(cleanupSequence < firstConfirmation && lastConfirmation === finalAction)) {
        context.addIssue({ code: "custom", path: ["stages"], message: "In-product cleanup must prove the deleted state after its one permitted delete action." })
      }
    } else if (cleanupConfirmations.length) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Webhook cleanup uses its idempotent success receipt and cannot include browser confirmation actions." })
    }
  } else {
    if (cleanupStages.length || cleanupActions.length || emailLinks.length || emailWaits.length > 1) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Lead form supports an optional email proof but no verification-link or account-cleanup actions." })
    }
    if (emailWaits[0] && emailWaits[0].sequence <= submitSequence) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Lead-form email proof must run after the single synthetic submission." })
    }
    if (
      emailWaits.some((item) => item.action.type === "wait_for_email" && item.action.proofMode === "forwarded_marker")
      && !syntheticFills.some((item) => item.action.type === "fill" && item.action.operation === "text" && item.action.valueKey === "message")
    ) {
      context.addIssue({ code: "custom", path: ["stages"], message: "Forwarded lead proof must submit the unique run marker through a mapped message field." })
    }
  }
  if (cleanupStages.some((stage) => stage.position !== Math.max(...draft.stages.map((item) => item.position)))) {
    context.addIssue({ code: "custom", path: ["stages"], message: "Cleanup must be the final journey stage." })
  }
  for (const [index, stage] of cleanupStages.entries()) {
    const cleanupActions = stage.actions.filter((action) => action.type === "cleanup")
    if (cleanupActions.length !== 1 || cleanupActions[0]?.mode !== draft.cleanupMode) {
      context.addIssue({ code: "custom", path: ["stages", index, "actions"], message: "The cleanup stage must match the selected cleanup mode." })
    }
    const cleanup = cleanupActions[0]
    if (cleanup?.type === "cleanup" && cleanup.mode === "in_product" && !cleanup.locator) {
      context.addIssue({ code: "custom", path: ["stages", index, "actions"], message: "In-product cleanup requires an approved semantic locator." })
    }
    if (cleanup?.type === "cleanup" && cleanup.mode === "webhook" && !cleanup.webhookUrl) {
      context.addIssue({ code: "custom", path: ["stages", index, "actions"], message: "Webhook cleanup requires a public HTTPS URL." })
    }
  }
  if (draft.emailProofConfigured !== (emailWaits.length > 0)) {
    context.addIssue({ code: "custom", path: ["emailProofConfigured"], message: "Email coverage must match the configured email assertion." })
  }
})

export const journeyPublishSchema = z.object({
  expectedDraftRevision: z.number().int().min(0),
  supervisedRunId: uuidSchema.optional(),
})

export const journeyScheduleSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(60).max(43_200),
})

export const enqueueEvalRunSchema = z.object({
  journeyId: uuidSchema,
  mode: z.enum(["manual", "supervised", "verification", "debug"]).default("manual"),
  incidentId: uuidSchema.optional(),
})

export const incidentMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), ownerUserId: uuidSchema }),
  z.object({ action: z.literal("snooze"), until: z.string().datetime() }),
  z.object({ action: z.literal("record_repair"), note: z.string().trim().min(1).max(4_000) }),
  z.object({ action: z.literal("verify") }),
])

export const createReportSchema = z.object({
  projectId: uuidSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
})

export const reportShareLinkSchema = z.object({
  expiresInHours: z.number().int().min(1).max(24 * 90).default(168),
})

export const alertEndpointSchema = z.object({
  kind: z.enum(["email", "webhook"]),
  name: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1).max(2_048),
  enabled: z.boolean().default(true),
})

/**
 * AI assistance accepts only the semantic, already-reduced builder model. Raw
 * DOM, screenshots, email bodies, headers, cookies, CSS and XPath are not part
 * of this contract, so they cannot accidentally cross the provider boundary.
 */
export const aiSafeSyntheticValueKeySchema = z.enum([
  "marker",
  "first_name",
  "last_name",
  "full_name",
  "name",
  "email",
  "company",
  "workspace",
  "message",
  "password",
  "number",
  "url",
])

export const aiSemanticLocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({ kind: z.literal("label"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("placeholder"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("test_id"), value: z.string().trim().min(1).max(200) }).strict(),
])

const aiBuilderKeySchema = z.string().trim().min(1).max(80).regex(
  /^[A-Za-z0-9_.:-]+$/,
  "Builder keys may contain letters, numbers, dots, underscores, colons and hyphens only."
)

const aiJourneyFieldSchema = z.object({
  key: aiBuilderKeySchema,
  control: z.enum(["input", "textarea", "select"]),
  inputType: z.string().trim().max(40),
  label: z.string().trim().max(200),
  name: z.string().trim().max(200),
  required: z.boolean(),
  options: z.array(z.object({
    value: z.string().trim().max(200),
    label: z.string().trim().max(200),
    disabled: z.boolean(),
  }).strict()).max(50),
  locator: aiSemanticLocatorSchema.nullable(),
  currentValueKey: aiSafeSyntheticValueKeySchema.nullable(),
}).strict()

const aiJourneyActionSchema = z.object({
  key: aiBuilderKeySchema,
  label: z.string().trim().min(1).max(200),
  role: z.literal("button"),
  locator: aiSemanticLocatorSchema.nullable(),
}).strict()

const aiJourneyStageContextSchema = z.object({
  key: aiBuilderKeySchema,
  name: z.string().trim().min(1).max(120),
  position: z.number().int().min(0).max(30),
  expected: z.string().trim().max(1_000),
  businessImpact: z.string().trim().max(1_000),
}).strict()

export const aiJourneyDraftRequestSchema = z.object({
  projectId: uuidSchema,
  journeyId: uuidSchema.nullable(),
  draftRevision: z.number().int().min(0).nullable(),
  template: z.enum(["lead_form", "trial_signup"]),
  startUrl: httpsUrlSchema,
  objective: z.string().trim().max(1_000),
  fields: z.array(aiJourneyFieldSchema).max(50),
  actions: z.array(aiJourneyActionSchema).max(20),
  stages: z.array(aiJourneyStageContextSchema).min(1).max(30),
}).strict().superRefine((input, context) => {
  if ((input.journeyId === null) !== (input.draftRevision === null)) {
    context.addIssue({
      code: "custom",
      path: ["draftRevision"],
      message: "Saved journeys require both a journey ID and its current draft revision.",
    })
  }
  for (const [path, values] of [
    ["fields", input.fields],
    ["actions", input.actions],
    ["stages", input.stages],
  ] as const) {
    const keys = new Set<string>()
    values.forEach((value, index) => {
      if (keys.has(value.key)) {
        context.addIssue({ code: "custom", path: [path, index, "key"], message: `${path} keys must be unique.` })
      }
      keys.add(value.key)
    })
  }
})

export const aiRunDiagnosisRequestSchema = z.object({
  runId: uuidSchema,
}).strict()

export type PageQuery = z.infer<typeof pageQuerySchema>
export type ProjectCreateInput = z.infer<typeof createProjectSchema>
export type ProjectUpdateInput = z.infer<typeof updateProjectSchema>
export type JourneyDraftInput = z.infer<typeof journeyDraftSchema>
export type RestrictedAction = z.infer<typeof restrictedActionSchema>
export type LocatorDefinition = z.infer<typeof locatorSchema>
export type JourneyStageDraft = z.infer<typeof journeyStageDraftSchema>
export type EvalRunInput = z.infer<typeof enqueueEvalRunSchema>
export type AiJourneyDraftRequest = z.infer<typeof aiJourneyDraftRequestSchema>
export type AiRunDiagnosisRequest = z.infer<typeof aiRunDiagnosisRequestSchema>

export async function parseRequestJson<TSchema extends z.ZodType>(request: Request, schema: TSchema) {
  const payload = await request.json().catch(() => null)
  return schema.parse(payload) as z.infer<TSchema>
}

export function requireIdempotencyKey(request: Request) {
  return idempotencyKeySchema.parse(request.headers.get("idempotency-key") ?? "")
}
