export const businessEvalsFeatureFlag = "NEXT_PUBLIC_BUSINESS_EVALS_UI"

export function isBusinessEvalsUiEnabled(env: Partial<Record<string, string | undefined>> = process.env) {
  const value = env[businessEvalsFeatureFlag]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "enabled"
}

export function isBusinessEvalsWorkspaceEnabled(
  workspaceId: string,
  env: Partial<Record<string, string | undefined>> = process.env
) {
  if (isBusinessEvalsUiEnabled(env)) return true
  const allowlist = new Set((env.BUSINESS_EVALS_WORKSPACE_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))
  return Boolean(workspaceId) && allowlist.has(workspaceId.trim().toLowerCase())
}

export function isBusinessEvalsRunnerEnabled(env: Partial<Record<string, string | undefined>> = process.env) {
  const value = env.BUSINESS_EVALS_RUNNER_ENABLED?.trim().toLowerCase()
  const killed = env.BUSINESS_EVALS_RUNNER_KILL_SWITCH?.trim().toLowerCase()
  return ["1", "true", "enabled"].includes(value ?? "")
    && !["1", "true", "enabled"].includes(killed ?? "")
}
