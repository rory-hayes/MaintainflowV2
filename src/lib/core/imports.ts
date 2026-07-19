export type PlatformImportResult = {
  platform: "n8n" | "make" | "zapier" | "openapi" | "postman" | "url" | "unknown"
  endpointUrl: string
  method: string
  name: string
  warnings: string[]
  suggestedChecks: string[]
  pendingSetup: boolean
}

const urlPattern = /https?:\/\/[^\s"'<>)}\]]+/i

export function detectPlatformImport(input: string): PlatformImportResult {
  const trimmed = input.trim()
  const url = trimmed.match(urlPattern)?.[0] ?? ""
  const parsed = safeJson(trimmed)
  const result: PlatformImportResult = {
    platform: "unknown",
    endpointUrl: url,
    method: "GET",
    name: "Imported workflow",
    warnings: [],
    suggestedChecks: ["Expected status 200", "Response exists", "Max latency 5 seconds"],
    pendingSetup: !url,
  }

  if (!trimmed) {
    return {
      ...result,
      warnings: ["Paste a platform export, endpoint URL, or JSON document."],
      pendingSetup: true,
    }
  }

  if (!parsed) {
    return {
      ...result,
      platform: url ? "url" : "unknown",
      name: url ? "Imported URL workflow" : "Imported workflow",
      warnings: url ? [] : ["No callable production URL was detected."],
      pendingSetup: !url,
    }
  }

  if (Array.isArray(parsed.nodes) || hasKey(parsed, "nodes")) {
    return {
      ...result,
      platform: "n8n",
      name: stringValue(parsed, "name") || "Imported n8n workflow",
      warnings: url ? [] : ["n8n export detected, but no callable webhook URL was found."],
      pendingSetup: !url,
    }
  }

  if (Array.isArray(parsed.flow) || Array.isArray(parsed.modules)) {
    return {
      ...result,
      platform: "make",
      name: stringValue(parsed, "name") || "Imported Make scenario",
      warnings: url ? [] : ["Make blueprint detected, but no production webhook URL was found."],
      pendingSetup: !url,
    }
  }

  if (Array.isArray(parsed.item) && hasKey(parsed, "info")) {
    return {
      ...result,
      platform: "postman",
      name: stringValue(parsed.info, "name") || "Imported Postman collection",
      warnings: url ? [] : ["Postman collection detected, but no concrete request URL was found."],
      pendingSetup: !url,
    }
  }

  if (hasKey(parsed, "openapi") || hasKey(parsed, "swagger")) {
    const serverUrl = Array.isArray(parsed.servers) ? stringValue(parsed.servers[0], "url") : ""
    return {
      ...result,
      platform: "openapi",
      endpointUrl: serverUrl || url,
      name: stringValue(parsed.info, "title") || "Imported OpenAPI workflow",
      warnings: serverUrl || url ? [] : ["OpenAPI document detected, but no server URL was found."],
      pendingSetup: !(serverUrl || url),
    }
  }

  if (hasKey(parsed, "zap") || Array.isArray(parsed.steps)) {
    return {
      ...result,
      platform: "zapier",
      name: stringValue(parsed, "name") || "Imported Zapier workflow",
      warnings: url ? [] : ["Zapier export detected, but no callable hook URL was found."],
      pendingSetup: !url,
    }
  }

  return {
    ...result,
    warnings: url ? ["JSON detected, but platform metadata was not recognized."] : ["No callable production URL was detected."],
    pendingSetup: !url,
  }
}

function safeJson(input: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(input)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function hasKey(value: unknown, key: string) {
  return Boolean(value && typeof value === "object" && key in value)
}

function stringValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") {
    return ""
  }

  const output = (value as Record<string, unknown>)[key]
  return typeof output === "string" ? output : ""
}
