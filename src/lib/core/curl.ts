import type { WorkflowMethod } from "./types.ts"

export type ParsedCurl = {
  url: string
  method: WorkflowMethod
  headers: Record<string, string>
  body: string
  contentType: string
}

const methodSet = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

export function parseCurlCommand(input: string): ParsedCurl {
  const tokens = tokenize(input.trim())
  if (!tokens.length || tokens[0].toLowerCase() !== "curl") {
    throw new Error("Paste a cURL command that starts with curl.")
  }

  let url = ""
  let method: WorkflowMethod = "GET"
  let body = ""
  const headers: Record<string, string> = {}

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]

    if (token === "-X" || token === "--request") {
      const candidate = (next ?? "").toUpperCase()
      if (!methodSet.has(candidate)) {
        throw new Error(`Unsupported cURL method: ${next || "missing"}.`)
      }
      method = candidate as WorkflowMethod
      index += 1
      continue
    }

    if (token === "-H" || token === "--header") {
      if (!next) {
        throw new Error("A cURL header flag is missing its value.")
      }
      const separator = next.indexOf(":")
      if (separator === -1) {
        throw new Error(`Header "${next}" must use Name: value format.`)
      }
      const key = next.slice(0, separator).trim()
      const value = next.slice(separator + 1).trim()
      if (key) {
        headers[key] = value
      }
      index += 1
      continue
    }

    if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"].includes(token)) {
      body = next ?? ""
      if (method === "GET") {
        method = "POST"
      }
      index += 1
      continue
    }

    if (!token.startsWith("-") && !url) {
      url = token
    }
  }

  if (!url) {
    throw new Error("The cURL command does not include a URL.")
  }

  return {
    url,
    method,
    headers,
    body,
    contentType: findHeader(headers, "content-type") || inferContentType(body),
  }
}

function findHeader(headers: Record<string, string>, name: string) {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  return entry?.[1] ?? ""
}

function inferContentType(body: string) {
  const trimmed = body.trim()
  if (!trimmed) {
    return ""
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "application/json"
  }

  return "text/plain"
}

function tokenize(input: string) {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null
  let escaped = false

  for (const character of input.replace(/\\\n/g, " ")) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }

    if (character === "\\") {
      escaped = true
      continue
    }

    if (quote) {
      if (character === quote) {
        quote = null
      } else {
        current += character
      }
      continue
    }

    if (character === "'" || character === "\"") {
      quote = character
      continue
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += character
  }

  if (quote) {
    throw new Error("The cURL command has an unclosed quote.")
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}
