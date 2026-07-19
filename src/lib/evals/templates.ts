import { validateActionManifest } from "./manifest.ts"
import type { JourneyAction, JourneyDefinitionDraft, JourneyTemplate } from "./types.ts"

const DEFAULT_ACTION_TIMEOUT_MS = 10_000
type WithoutActionBase<T> = T extends unknown ? Omit<T, "id" | "label" | "timeoutMs"> : never
type JourneyActionDefinition = WithoutActionBase<JourneyAction>

export function journeyTemplateDefinition(template: JourneyTemplate, startUrl: string): JourneyDefinitionDraft {
  const startHost = new URL(startUrl).hostname.toLowerCase()
  const definitions: Record<JourneyTemplate, JourneyDefinitionDraft> = {
    lead_form: {
      template,
      startUrl,
      emailProofConfigured: false,
      cleanupMode: "none",
      stages: [
        stage("page_loaded", "Page loaded", [
          action("open_lead_form", "Open lead form", { type: "navigate", url: startUrl }),
          action("lead_form_visible", "Lead form is visible", {
            type: "assert_visible",
            locator: { kind: "role", role: "form", name: "Lead form" },
          }),
        ], "The lead form is available.", "Prospects can begin an enquiry."),
        stage("form_submitted", "Form submitted", [
          action("fill_lead_email", "Enter synthetic email", {
            type: "fill",
            operation: "text",
            locator: { kind: "label", value: "Email" },
            valueKey: "email",
          }),
          action("submit_lead_form", "Submit lead form", {
            type: "click",
            locator: { kind: "role", role: "button", name: "Submit" },
          }),
        ], "The form accepts marked synthetic test data.", "A prospect can submit a lead."),
        stage("success_confirmed", "Success confirmed", [
          action("wait_for_success", "Wait for success confirmation", { type: "wait_for_text", text: "Thank you" }),
        ], "A success state is visible.", "The prospect knows the enquiry was received."),
      ],
    },
    trial_signup: {
      template,
      startUrl,
      emailProofConfigured: true,
      cleanupMode: "in_product",
      stages: [
        stage("signup_opened", "Signup opened", [
          action("open_trial_signup", "Open trial signup", { type: "navigate", url: startUrl }),
          action("signup_form_visible", "Signup form is visible", {
            type: "assert_visible",
            locator: { kind: "role", role: "form", name: "Trial signup" },
          }),
        ], "The signup form is available.", "A buyer can start a trial."),
        stage("signup_submitted", "Signup submitted", [
          action("fill_signup_email", "Enter synthetic email", {
            type: "fill",
            operation: "text",
            locator: { kind: "label", value: "Email" },
            valueKey: "email",
          }),
          action("submit_signup", "Create synthetic account", {
            type: "click",
            locator: { kind: "role", role: "button", name: "Create account" },
          }),
        ], "Synthetic signup data is accepted.", "A buyer can request an account."),
        stage("verification_received", "Verification email received", [
          action("wait_for_verification_email", "Wait for verification email", {
            type: "wait_for_email",
            recipientKey: "email",
            proofMode: "autoresponse",
            thresholdSeconds: 120,
            maximumWaitSeconds: 600,
          }, 60_000),
        ], "The verification email arrives.", "The buyer can continue onboarding."),
        stage("verification_opened", "Verification opened", [
          action("open_verification_link", "Open approved verification link", {
            type: "open_email_link",
            allowedHosts: [startHost],
            linkRule: { host: startHost, pathPrefix: "/verify" },
          }),
        ], "The approved verification link opens.", "The buyer can verify the account."),
        stage("workspace_created", "Workspace created", [
          action("workspace_visible", "Workspace is visible", {
            type: "assert_visible",
            locator: { kind: "role", role: "main", name: "Workspace" },
          }),
        ], "The first authenticated workspace loads.", "The buyer reaches product value."),
        stage("cleanup_test_account", "Cleanup test account", [
          action("delete_test_account", "Delete synthetic test account", {
            type: "cleanup",
            mode: "in_product",
            locator: { kind: "role", role: "button", name: "Delete test account" },
          }),
          action("confirm_test_account_deleted", "Confirm test account deletion", {
            type: "wait_for_text",
            text: "Account deleted",
          }),
        ], "The synthetic test account is removed.", "Scheduled tests do not pollute customer or billing data.", true),
      ],
    },
    legacy_endpoint: {
      template,
      startUrl,
      emailProofConfigured: false,
      cleanupMode: "none",
      stages: [
        stage("endpoint_response", "Endpoint response", [
          action("legacy_endpoint_navigate", "Open the approved endpoint", { type: "navigate", url: startUrl }),
        ], "The approved endpoint returns a reachable response.", "The monitored journey remains available."),
      ],
    },
  }
  return {
    ...definitions[template],
    stages: definitions[template].stages.map((item, position) => ({ ...item, position })),
  }
}

function action<T extends JourneyActionDefinition>(
  id: string,
  label: string,
  definition: T,
  timeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
): JourneyAction {
  return { id, label, timeoutMs, ...definition } as JourneyAction
}

function stage(
  key: string,
  name: string,
  actions: JourneyAction[],
  expected: string,
  businessImpact: string,
  cleanup = false,
) {
  const manifest = validateActionManifest({ actions })
  return {
    key,
    name,
    position: 0,
    required: true,
    cleanup,
    actions: manifest.actions,
    expected,
    businessImpact,
    timingThresholdMs: null,
  }
}
