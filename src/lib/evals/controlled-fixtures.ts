export const controlledFixtureScenarios = [
  "healthy-lead",
  "failed-lead",
  "delayed-email",
  "captcha-blocked",
  "missing-email",
  "malicious-link",
  "healthy-trial",
  "cleanup-failure",
] as const

export type ControlledFixtureScenario = (typeof controlledFixtureScenarios)[number]

export function controlledFixtureScenario(value: unknown): ControlledFixtureScenario | null {
  return typeof value === "string" && (controlledFixtureScenarios as readonly string[]).includes(value)
    ? value as ControlledFixtureScenario
    : null
}

export function controlledFixtureTemplate(scenario: ControlledFixtureScenario) {
  return scenario === "healthy-trial" || scenario === "cleanup-failure" || scenario === "malicious-link"
    ? "trial_signup" as const
    : "lead_form" as const
}

export function isControlledFixtureEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.NODE_ENV !== "production") return true
  return ["1", "true", "enabled"].includes(env.BUSINESS_EVALS_FIXTURES_ENABLED?.trim().toLowerCase() ?? "")
}
