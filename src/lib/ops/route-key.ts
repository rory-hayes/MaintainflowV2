type OpsRouteEnv = Record<string, string | undefined>

const DEFAULT_LOCAL_OPS_ROUTE_KEY = "mf-command-center"

export function getOpsRouteKey(env: OpsRouteEnv = process.env) {
  const configured = normalizeOpsRouteKey(env.MAINTAINFLOW_OPS_ROUTE_KEY)
  return configured || DEFAULT_LOCAL_OPS_ROUTE_KEY
}

export function isOpsRouteKey(value: string, env: OpsRouteEnv = process.env) {
  return normalizeOpsRouteKey(value) === getOpsRouteKey(env)
}

function normalizeOpsRouteKey(value: string | undefined) {
  return String(value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
}
