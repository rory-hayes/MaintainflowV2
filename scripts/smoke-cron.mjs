import { readFileSync } from "node:fs"

const env = readEnvFile(".env.local")
const appUrl = (process.env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "")
const cronSecret = process.env.CRON_SECRET || env.CRON_SECRET
const cronUrl = `${appUrl}/api/cron/run-checks`

const unauthorized = await postJson(cronUrl, {}, {})
if (unauthorized.status !== 401) {
  throw new Error(`Expected unauthenticated cron request to return 401, received ${unauthorized.status}.`)
}

console.log(`Unauthorized cron request rejected at ${cronUrl}.`)

if (!cronSecret) {
  console.log("CRON_SECRET is not configured, skipping authorized cron smoke.")
  process.exit(0)
}

const authorized = await postJson(
  cronUrl,
  { batchSize: Number(process.env.CHECK_RUNNER_BATCH_SIZE || env.CHECK_RUNNER_BATCH_SIZE || 5) },
  { Authorization: `Bearer ${cronSecret}` }
)

if (authorized.status < 200 || authorized.status >= 300) {
  throw new Error(`Authorized cron request failed with ${authorized.status}: ${JSON.stringify(authorized.body)}`)
}

console.log(`Authorized cron request succeeded: ${JSON.stringify(redactCronResponse(authorized.body))}`)

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
