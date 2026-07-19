export function preserveValidDatabaseTimestamp(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
    return null
  }
  return value
}
