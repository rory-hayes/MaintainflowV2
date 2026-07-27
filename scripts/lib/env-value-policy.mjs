export function isConcreteEnvValue(value) {
  const normalized = stripWrappingQuotes(String(value ?? "").trim())
  return normalized.length > 0 && !/^\[(?:sensitive|redacted)\]$/i.test(normalized)
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) return value.slice(1, -1).trim()

  return value
}
