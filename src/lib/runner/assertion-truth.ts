export function isPlaywrightTimeoutError(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError"
}
