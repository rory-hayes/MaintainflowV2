import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  businessEvalsAccessResponseSchema,
  businessEvalsErrorEnvelopeSchema,
  businessEvalsSuccessEnvelopeSchema,
  enqueuedEvalRunResponseSchema,
  journeyScanResponseSchema,
  parseBusinessEvalsResponsePayload,
  projectResponseSchema,
  verificationEnqueuedEvalRunResponseSchema,
  workspaceSettingsResponseSchema,
} from "../src/lib/api/business-evals-response-schemas.ts"

test("success and error envelopes are strict and success data is parsed by its endpoint schema", () => {
  const accessEnvelope = businessEvalsSuccessEnvelopeSchema(businessEvalsAccessResponseSchema)
  assert.equal(accessEnvelope.safeParse({
    ok: true,
    data: { enabled: true, workspaceId: "workspace-1" },
    meta: { nextCursor: null },
  }).success, true)
  assert.equal(accessEnvelope.safeParse({
    ok: true,
    data: { enabled: "yes", workspaceId: "workspace-1" },
  }).success, false)
  assert.equal(accessEnvelope.safeParse({
    ok: true,
    data: { enabled: true, workspaceId: "workspace-1" },
    unapprovedEnvelopeField: true,
  }).success, false)
  assert.equal(accessEnvelope.safeParse({
    ok: true,
    data: { enabled: true, workspaceId: "workspace-1" },
    meta: { nextCursor: 42 },
  }).success, false)

  assert.equal(businessEvalsErrorEnvelopeSchema.safeParse({
    ok: false,
    error: { code: "ROLE_REQUIRED", message: "The action is unavailable." },
  }).success, true)
  assert.equal(businessEvalsErrorEnvelopeSchema.safeParse({
    ok: false,
    error: { message: "Missing a stable error code." },
  }).success, false)

  assert.deepEqual(parseBusinessEvalsResponsePayload({
    ok: true,
    data: { enabled: true, workspaceId: "workspace-1" },
  }, businessEvalsAccessResponseSchema), {
    ok: true,
    data: { enabled: true, workspaceId: "workspace-1" },
  })
  assert.equal(parseBusinessEvalsResponsePayload({
    ok: true,
    data: { enabled: "yes", workspaceId: "workspace-1" },
  }, businessEvalsAccessResponseSchema), null)
})

test("resource schemas reject malformed fields instead of letting mapping code silently invent defaults", () => {
  const project = {
    id: "project-1",
    name: "Example",
    website: "https://example.com",
    kind: "client_site",
    health: "healthy",
    activeJourneys: 2,
    legacyEndpointJourneys: 1,
    businessEvalJourneys: 1,
    openIncidents: 0,
    lastRunAt: null,
    ownerUserId: null,
    reportStatus: null,
    archivedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  }
  assert.equal(projectResponseSchema.safeParse(project).success, true)
  assert.equal(projectResponseSchema.safeParse({ ...project, activeJourneys: "2" }).success, false)

  const workspace = {
    id: "workspace-1",
    name: "Maintain Flow",
    slug: "maintain-flow",
    logoUrl: "",
    primaryColor: null,
    reportSenderName: "",
    reportSenderEmail: "",
    plan: "free",
    updatedAt: "2026-07-19T00:00:00.000Z",
  }
  assert.equal(workspaceSettingsResponseSchema.safeParse(workspace).success, true)
  assert.equal(workspaceSettingsResponseSchema.safeParse({ ...workspace, plan: 1 }).success, false)
})

test("scan responses preserve only supported semantic controls", () => {
  const scan = {
    url: "https://example.com/contact",
    title: "Contact",
    captchaDetected: false,
    fields: [{
      key: "field-0",
      control: "select",
      inputType: "select",
      label: "Country",
      name: "country",
      required: true,
      options: [{ value: "IE", label: "Ireland", disabled: false }],
      locator: { kind: "label", value: "Country" },
    }],
    actions: [{
      key: "action-0",
      label: "Submit",
      role: "button",
      locator: { kind: "role", role: "button", name: "Submit" },
    }],
    warnings: [],
    template: "lead_form",
    projectId: "project-1",
    approvedActionDomains: ["example.com"],
  }
  assert.equal(journeyScanResponseSchema.safeParse(scan).success, true)
  assert.equal(journeyScanResponseSchema.safeParse({
    ...scan,
    fields: [{ ...scan.fields[0], locator: { kind: "css", value: "#country" } }],
  }).success, false)
})

test("verification rerun responses carry the journey identity required by the adapter", () => {
  const enqueued = {
    id: "run-1",
    trigger: "verification",
    enqueued: true,
    quotaUsed: 1,
    quotaLimit: 750,
    orchestrationRunId: null,
  }
  assert.equal(enqueuedEvalRunResponseSchema.safeParse(enqueued).success, true)
  assert.equal(verificationEnqueuedEvalRunResponseSchema.safeParse(enqueued).success, false)
  assert.equal(verificationEnqueuedEvalRunResponseSchema.safeParse({ ...enqueued, journeyId: "journey-1" }).success, true)

  const route = readFileSync("src/app/api/incidents/[id]/route.ts", "utf8")
  assert.match(route, /journeyId: incident\.journeyId/)
})

test("every authenticated Business Evals request supplies a runtime response schema", () => {
  const callsiteFiles = [
    "src/components/evals/api-adapters.ts",
    "src/components/evals/use-route-scoped-evals.ts",
    "src/components/evals/pages/projects-pages.tsx",
    "src/components/evals/pages/journeys-pages.tsx",
    "src/components/evals/pages/journey-detail-page.tsx",
    "src/components/evals/pages/eval-runs-pages.tsx",
    "src/components/evals/pages/reports-pages.tsx",
    "src/components/evals/pages/settings-pages.tsx",
  ]
  const callsites = callsiteFiles.map((file) => readFileSync(file, "utf8")).join("\n")
  const client = readFileSync("src/lib/api/business-evals-client.ts", "utf8")

  assert.doesNotMatch(callsites, /businessEvalsRequest\s*</)
  assert.match(client, /dataSchema: TSchema/)
  assert.match(client, /parseBusinessEvalsResponsePayload\(payload, dataSchema\)/)
  assert.match(client, /INVALID_RESPONSE/)
})
