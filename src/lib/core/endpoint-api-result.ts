import type { EndpointTestResult } from "./types.ts"

export function acceptedEndpointApiResult(responseOk: boolean, result: EndpointTestResult) {
  if (!responseOk) {
    throw new Error(result.errorMessage || "Connection test could not run.")
  }
  return result
}
