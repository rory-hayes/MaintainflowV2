import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  compileOperatorApprovedCheckActions,
  controlMappingsAreReady,
  groupRadioFields,
  inferSyntheticValueKey,
  isPhoneLikeField,
  isSupportedFormField,
  safeSyntheticValueKeys,
  type ScannedFormField,
} from "../src/lib/evals/form-control-mapping.ts"
import { validateActionManifest } from "../src/lib/evals/manifest.ts"
import { createSyntheticRunValues } from "../src/lib/runner/synthetic-values.ts"

const locator = (value: string) => ({ kind: "label" as const, value })
const field = (overrides: Partial<ScannedFormField> & Pick<ScannedFormField, "key" | "label">): ScannedFormField => ({
  control: "input",
  inputType: "text",
  name: overrides.key,
  required: false,
  options: [],
  locator: locator(overrides.label),
  ...overrides,
})

test("telephone and messaging fields cannot compile dialable synthetic contact data", () => {
  const telephone = field({ key: "phone", label: "Phone number", inputType: "tel", required: true })
  const disguisedSms = field({ key: "contact", label: "SMS contact", inputType: "text" })

  assert.equal(isPhoneLikeField(telephone), true)
  assert.equal(isPhoneLikeField(disguisedSms), true)
  assert.equal(isSupportedFormField(telephone), false)
  assert.equal(isSupportedFormField(disguisedSms), false)
  assert.throws(() => inferSyntheticValueKey(telephone), /cannot receive synthetic contact data/)
  assert.equal(safeSyntheticValueKeys.includes("phone" as never), false)

  const values = createSyntheticRunValues({
    runId: "019f7576-dbaa-7a02-9787-d0f9a03b48e4",
    syntheticMarker: "MF-EVAL-019F7576DBAA7A029787",
    inboundDomain: "evals.maintainflow.test",
  })
  assert.equal(values.phone, "NOT-A-PHONE")
  assert.doesNotMatch(values.phone, /\d/)
  assert.throws(() => validateActionManifest({ actions: [{
    id: "phone",
    label: "Fill phone",
    type: "fill",
    operation: "text",
    locator: locator("Phone"),
    valueKey: "phone",
    timeoutMs: 10_000,
  }] }), /non-contactable synthetic value key/)
})

test("checkboxes are untouched by default and compile only after explicit operator approval", () => {
  const marketing = field({
    key: "marketing",
    label: "Send me marketing and SMS",
    inputType: "checkbox",
    name: "marketing",
    options: [{ value: "yes", label: "Send me marketing and SMS", disabled: false }],
  })
  assert.equal(controlMappingsAreReady({ fields: [marketing], approvedCheckboxes: {}, radioChoices: {} }), true)
  assert.deepEqual(compileOperatorApprovedCheckActions({ fields: [marketing], approvedCheckboxes: {}, radioChoices: {} }), [])

  const requiredTerms = { ...marketing, key: "terms", label: "Accept test-account terms", name: "terms", required: true, locator: locator("Accept test-account terms") }
  assert.equal(controlMappingsAreReady({ fields: [requiredTerms], approvedCheckboxes: {}, radioChoices: {} }), false)
  assert.throws(
    () => compileOperatorApprovedCheckActions({ fields: [requiredTerms], approvedCheckboxes: {}, radioChoices: {} }),
    /Explicitly approve the required checkbox/,
  )
  const actions = compileOperatorApprovedCheckActions({ fields: [requiredTerms], approvedCheckboxes: { terms: true }, radioChoices: {} })
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0], {
    id: "check_terms_0",
    label: "Select operator-approved checkbox Accept test-account terms",
    type: "fill",
    operation: "check",
    locator: locator("Accept test-account terms"),
    expectedChecked: true,
    controlKind: "checkbox",
    operatorApproved: true,
    timeoutMs: 10_000,
  })
})

test("radio groups require one deterministic operator choice and reject ambiguous required groups", () => {
  const email = field({ key: "email-choice", label: "Email", inputType: "radio", name: "contact_method", required: true, options: [{ value: "email", label: "Email", disabled: false }] })
  const sms = field({ key: "sms-choice", label: "SMS", inputType: "radio", name: "contact_method", required: false, options: [{ value: "sms", label: "SMS", disabled: false }] })
  const groups = groupRadioFields([email, sms])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.required, true)
  assert.equal(controlMappingsAreReady({ fields: [email, sms], approvedCheckboxes: {}, radioChoices: {} }), false)
  assert.throws(
    () => compileOperatorApprovedCheckActions({ fields: [email, sms], approvedCheckboxes: {}, radioChoices: {} }),
    /Choose one operator-approved option/,
  )

  const actions = compileOperatorApprovedCheckActions({ fields: [email, sms], approvedCheckboxes: {}, radioChoices: { "name:contact_method": "email-choice" } })
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.type, "fill")
  assert.equal(actions[0]?.operation, "check")
  if (actions[0]?.type === "fill" && actions[0].operation === "check") {
    assert.equal(actions[0].controlKind, "radio")
    assert.equal(actions[0].radioGroup, "contact_method")
    assert.equal(actions[0].operatorApproved, true)
  }

  const unnamed = field({ key: "unknown", label: "Required choice", inputType: "radio", name: "", required: true, options: [{ value: "yes", label: "Yes", disabled: false }] })
  assert.equal(groupRadioFields([unnamed])[0]?.ambiguous, true)
  assert.equal(controlMappingsAreReady({ fields: [unnamed], approvedCheckboxes: {}, radioChoices: {} }), false)
  assert.throws(
    () => compileOperatorApprovedCheckActions({ fields: [unnamed], approvedCheckboxes: {}, radioChoices: {} }),
    /semantic group is ambiguous/,
  )
})

test("restricted manifests require explicit control approval and prevent duplicate radio selections", () => {
  const checked = (id: string, label: string) => ({
    id,
    label,
    type: "fill",
    operation: "check",
    locator: locator(label),
    expectedChecked: true,
    operatorApproved: true,
    controlKind: "radio",
    radioGroup: "contact_method",
    timeoutMs: 10_000,
  })
  assert.throws(() => validateActionManifest({ actions: [{
    ...checked("sms", "SMS"),
    operatorApproved: undefined,
  }] }), /explicit operator approval/)
  assert.throws(() => validateActionManifest({ actions: [checked("email", "Email"), checked("sms", "SMS")] }), /only one option per semantic radio group/)

  const runner = readFileSync("src/lib/runner/playwright-engine.server.ts", "utf8")
  assert.match(runner, /await assertPublishedCheckControl\(locator, action\)/)
  assert.match(runner, /identity\.type !== action\.controlKind/)
  assert.match(runner, /action\.controlKind === "radio" && identity\.name !== action\.radioGroup/)
})

test("publication re-resolves paid feature entitlement immediately before the immutable write", () => {
  const source = readFileSync("src/lib/api/journeys.server.ts", "utf8")
  const start = source.indexOf("export async function publishJourney")
  const end = source.indexOf("export async function pauseJourney", start)
  const body = source.slice(start, end)
  const authorization = body.indexOf("assertProjectAuthorizedForUrl")
  const entitlement = body.indexOf("getBusinessEvalsEntitlement", authorization)
  const assertion = body.indexOf("assertJourneyEntitlements", entitlement)
  const immutableWrite = body.indexOf('rpc/publish_journey_version', assertion)
  assert.ok(authorization >= 0 && authorization < entitlement)
  assert.ok(entitlement < assertion)
  assert.ok(assertion < immutableWrite)
  assert.match(body, /journey\.template === "lead_form" \|\| journey\.template === "trial_signup"/)
  assert.match(body, /journey\.draft\.emailProofConfigured === true/)

  const migration = readFileSync("supabase/maintainflow_business_evals_migration.sql", "utf8")
  const sqlStart = migration.indexOf("create or replace function public.publish_journey_version")
  const sqlEnd = migration.indexOf("create or replace function public.record_project_authorization", sqlStart)
  const publishSql = migration.slice(sqlStart, sqlEnd)
  const agencyLock = publishSql.indexOf("select * into saved_agency from public.agencies")
  const paidRequirement = publishSql.indexOf("requires_paid_features :=", agencyLock)
  const paidGuard = publishSql.indexOf("if requires_paid_features and not paid_features_available", paidRequirement)
  const versionInsert = publishSql.indexOf("insert into public.journey_versions", paidGuard)
  assert.ok(agencyLock >= 0 && agencyLock < paidRequirement)
  assert.ok(paidRequirement < paidGuard)
  assert.ok(paidGuard < versionInsert)
  assert.match(publishSql, /for share;/)
  assert.match(publishSql, /stripe_subscription_status, ''\) in \('trialing', 'active'\)/)
  assert.match(publishSql, /team_trial_ends_at, saved_agency\.trial_ends_at\) > now\(\)/)
})
