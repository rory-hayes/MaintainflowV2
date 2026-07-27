import { readFileSync } from "node:fs"

import { validateCredentialBearingAppOrigin } from "./lib/credential-target-policy.mjs"

const env = readEnvFile(".env.local")
const appUrl = validateCredentialBearingAppOrigin(
  process.env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  { allowLocal: true, label: "NEXT_PUBLIC_APP_URL" },
)
const cronSecret = process.env.CRON_SECRET || env.CRON_SECRET
const cronTargets = [
  {
    name: "legacy check scheduler",
    url: `${appUrl}/api/cron/run-checks`,
    body: { batchSize: Number(process.env.CHECK_RUNNER_BATCH_SIZE || env.CHECK_RUNNER_BATCH_SIZE || 5) },
  },
  {
    name: "Browser Context cleanup scheduler",
    url: `${appUrl}/api/cron/cleanup-browser-contexts`,
    body: {
      batchSize: boundedInteger(
        process.env.BROWSER_CONTEXT_CLEANUP_BATCH_SIZE || env.BROWSER_CONTEXT_CLEANUP_BATCH_SIZE || 4,
        1,
        4,
      ),
    },
    assertResponse: assertSafeCleanupSummary,
  },
]

for (const target of cronTargets) {
  const unauthorized = await postJson(target.url, target.body, {})
  if (unauthorized.status !== 401) {
    throw new Error(`Expected unauthenticated ${target.name} request to return 401, received ${unauthorized.status}.`)
  }
  console.log(`Unauthorized ${target.name} request rejected at ${target.url}.`)
}

if (!cronSecret) {
  console.log("CRON_SECRET is not configured, skipping authorized cron smoke.")
  process.exit(0)
}

for (const target of cronTargets) {
  const authorized = await postJson(
    target.url,
    target.body,
    { Authorization: `Bearer ${cronSecret}` }
  )

  if (authorized.status < 200 || authorized.status >= 300) {
    throw new Error(
      `Authorized ${target.name} request failed with ${authorized.status}: ${JSON.stringify(redactCronResponse(authorized.body))}`
    )
  }

  target.assertResponse?.(authorized.body)
  console.log(`Authorized ${target.name} request succeeded: ${JSON.stringify(redactCronResponse(authorized.body))}`)
}

async function postJson(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })

  return {
    status: response.status,
    body: await response.json().catch(() => null),
  }
}

function readEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=")
          return [line.slice(0, separator), line.slice(separator + 1)]
        })
    )
  } catch {
    return {}
  }
}

function redactCronResponse(body) {
  if (!body || typeof body !== "object") {
    return body
  }

  const { errors, ...safeBody } = body
  return {
    ...safeBody,
    errors: Array.isArray(errors) ? errors.map(() => "[redacted]") : errors,
  }
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return maximum
  return Math.max(minimum, Math.min(Math.floor(parsed), maximum))
}

function assertSafeCleanupSummary(body) {
  const allowedKeys = new Set(["claimed", "deleted", "retryScheduled", "persistenceFailed"])
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Authorized Browser Context cleanup did not return an aggregate summary.")
  }
  for (const key of allowedKeys) {
    if (!Number.isInteger(body[key]) || body[key] < 0) {
      throw new Error(`Authorized Browser Context cleanup returned an invalid ${key} count.`)
    }
  }
  const unexpectedKeys = Object.keys(body).filter((key) => !allowedKeys.has(key))
  if (unexpectedKeys.length > 0) {
    throw new Error("Authorized Browser Context cleanup returned non-aggregate detail.")
  }
}
