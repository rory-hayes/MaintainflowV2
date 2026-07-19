export function safeAuthNextPath(value: string | null | undefined, fallback: string) {
  const candidate = value?.trim() ?? ""
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
    return fallback
  }

  try {
    const base = new URL("https://maintainflow.invalid")
    const resolved = new URL(candidate, base)
    return resolved.origin === base.origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : fallback
  } catch {
    return fallback
  }
}
