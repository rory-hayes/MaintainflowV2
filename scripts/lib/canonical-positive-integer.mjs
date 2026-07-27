export function parseCanonicalPositiveSafeInteger(value, key) {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${key} must be an explicit positive integer commercial ceiling.`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} must fit inside a safe integer.`)
  }
  return parsed
}

export function tryParseCanonicalPositiveSafeInteger(value, key) {
  try {
    return parseCanonicalPositiveSafeInteger(value, key)
  } catch {
    return null
  }
}
