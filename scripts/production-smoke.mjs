const defaultBaseUrl = "https://www.maintainflow.io"
const baseUrl = normalizeBaseUrl(
  process.env.SMOKE_PRODUCTION_URL ||
    process.env.PRODUCTION_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    defaultBaseUrl
)
const strictProtectedRoutes = process.env.SMOKE_STRICT_PROTECTED_ROUTES === "1"
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 15_000)

const checks = []

await checkHtml("/", {
  status: 200,
  includes: ["Maintain Flow"],
  excludes: ["TuesdayOps", "Open App Shell", "Workflow maintenance shell is live"],
  warnExcludes: ["Agencies using Maintain Flow"],
  securityHeaders: true,
})
await checkHtml("/sign-in", {
  status: 200,
  includes: ["Log in to Maintain Flow", "Email", "Password"],
  excludes: ["Local auth", "development auth", "jbhvlonypwqnvkzcawki.supabase.co"],
})
await checkHtml("/sign-up", {
  status: 200,
  includes: ["Create your account", "Email", "Password"],
  excludes: ["Local auth", "development auth", "jbhvlonypwqnvkzcawki.supabase.co"],
})
await checkHtml("/privacy", { status: 200, includes: ["Privacy", "Maintain Flow"] })
await checkHtml("/terms", { status: 200, includes: ["Terms", "Maintain Flow"] })
await checkHtml("/security", { status: 200, includes: ["Security", "Maintain Flow"] })
await checkText("/robots.txt", { status: 200, includes: ["Sitemap:"] })
await checkText("/sitemap.xml", { status: 200, includes: ["https://www.maintainflow.io/"] })
await checkRedirect("/contact-sales", "/sign-up")
await checkRedirect("/client-journey-assurance", "/sign-up")
await checkRedirect("/signup", "/sign-up")
await checkRedirect("/login", "/sign-in")
await checkText("/assurance", { status: 404, excludes: ["Client Journey Assurance workspace"] })

for (const path of [
  "/dashboard",
  "/action-center",
  "/clients",
  "/workflows",
  "/checks",
  "/issues",
  "/reports",
  "/settings",
  "/onboarding",
]) {
  await checkProtectedRoute(path)
}
await checkJson("/api/billing/status", {
  status: 401,
  assert: (body) => {
    if (!String(body?.error || "").toLowerCase().includes("sign in")) {
      throw new Error("billing status route did not require sign-in")
    }
  },
})

await checkJson("/api/cron/run-checks", {
  method: "POST",
  status: 401,
  assert: (body) => {
    if (body?.ok !== false || !String(body?.error || "").includes("Unauthorized")) {
      throw new Error("cron route did not reject unauthenticated request")
    }
  },
})
await checkJson("/api/checks/test", {
  method: "POST",
  body: {},
  status: 401,
  assert: (body) => {
    if (!String(body?.errorMessage || "").toLowerCase().includes("sign in")) {
      throw new Error("endpoint test route did not require sign-in")
    }
  },
})
await checkJson("/api/telemetry/event", {
  method: "POST",
  body: {},
  status: 401,
  assert: (body) => {
    if (body?.ok !== false) {
      throw new Error("telemetry route did not reject unauthenticated request")
    }
  },
})
await checkJson("/api/billing/checkout", {
  method: "POST",
  body: {},
  status: 401,
  assert: (body) => {
    if (!String(body?.error || "").toLowerCase().includes("sign in")) {
      throw new Error("checkout route did not require sign-in")
    }
  },
})
await checkJson("/api/billing/portal", {
  method: "POST",
  body: {},
  status: 401,
  assert: (body) => {
    if (!String(body?.error || "").toLowerCase().includes("sign in")) {
      throw new Error("portal route did not require sign-in")
    }
  },
})
await checkJson("/api/contact-sales", {
  method: "POST",
  body: {},
  status: 410,
  assert: (body) => {
    if (body?.signupUrl !== "/sign-up") {
      throw new Error("retired sales endpoint did not direct stale clients to signup")
    }
  },
})
for (const method of ["GET", "POST"]) {
  await checkJson("/api/cron/retry-lead-notifications", {
    method,
    status: 410,
    assert: (body) => {
      if (body?.ok !== false || !String(body?.message || "").toLowerCase().includes("retired")) {
        throw new Error("retired pilot retry route did not fail closed")
      }
    },
  })
}

for (const check of checks) {
  console.log(`${check.level.padEnd(5)} ${check.message}`)
}

const failures = checks.filter((check) => check.level === "FAIL")
const warnings = checks.filter((check) => check.level === "WARN")

console.log("")
console.log(`Production smoke target: ${baseUrl}`)
console.log(`Checks: ${checks.length}`)
console.log(`Failures: ${failures.length}`)
console.log(`Warnings: ${warnings.length}`)

if (failures.length) {
  process.exitCode = 1
}

async function checkHtml(path, options) {
  const { response, text } = await request(path)
  expectStatus(path, response, options.status)
  expectContentType(path, response, "text/html")
  if (options.securityHeaders) expectSecurityHeaders(path, response)
  expectIncludes(path, text, options.includes || [])
  expectExcludes(path, text, options.excludes || [])
  warnExcludes(path, text, options.warnExcludes || [])
  pass(`${path} rendered`)
}

function expectSecurityHeaders(path, response) {
  const contentSecurityPolicy =
    response.headers.get("content-security-policy") ||
    response.headers.get("content-security-policy-report-only") ||
    ""
  const requiredHeaders = [
    ["strict-transport-security", response.headers.get("strict-transport-security")],
    ["referrer-policy", response.headers.get("referrer-policy")],
    ["permissions-policy", response.headers.get("permissions-policy")],
  ]

  for (const [name, value] of requiredHeaders) {
    if (!value) fail(`${path} is missing ${name}`)
  }

  if (!contentSecurityPolicy) fail(`${path} is missing Content-Security-Policy or Content-Security-Policy-Report-Only`)

  const frameOptions = response.headers.get("x-frame-options") || ""
  if (!/deny|sameorigin/i.test(frameOptions) && !/frame-ancestors\s+(?:'none'|'self')/i.test(contentSecurityPolicy)) {
    fail(`${path} is missing an anti-framing policy`)
  }

  const contentTypeOptions = response.headers.get("x-content-type-options") || ""
  if (!contentTypeOptions) {
    fail(`${path} is missing x-content-type-options`)
  } else if (contentTypeOptions.toLowerCase() !== "nosniff") {
    fail(`${path} does not set X-Content-Type-Options to nosniff`)
  }
}

async function checkText(path, options) {
  const { response, text } = await request(path)
  expectStatus(path, response, options.status)
  expectIncludes(path, text, options.includes || [])
  expectExcludes(path, text, options.excludes || [])
  warnExcludes(path, text, options.warnExcludes || [])
  pass(`${path} rendered`)
}

async function checkRedirect(path, expectedPath) {
  const { response } = await request(path, { redirect: "manual" })
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    fail(`${path} expected a redirect, received HTTP ${response.status}`)
    return
  }
  const location = response.headers.get("location") || ""
  const redirected = location ? new URL(location, baseUrl).pathname : ""
  if (redirected !== expectedPath) {
    fail(`${path} redirected to ${redirected || "a missing location"}, expected ${expectedPath}`)
    return
  }
  pass(`${path} redirects to ${expectedPath}`)
}

async function checkJson(path, options) {
  const { response, text } = await request(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  expectStatus(path, response, options.status)
  expectContentType(path, response, "application/json")

  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    fail(`${path} returned invalid JSON`)
    return
  }

  try {
    options.assert?.(body)
    pass(`${path} returned expected JSON`)
  } catch (error) {
    fail(`${path} JSON assertion failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkProtectedRoute(path) {
  const { response, text } = await request(path)
  expectStatus(path, response, 200)
  expectContentType(path, response, "text/html")
  expectIncludes(path, text, ["Maintain Flow"])

  if (text.includes("Sign in to open this workspace") || text.includes("Log in to Maintain Flow")) {
    pass(`${path} presents a sign-in boundary`)
    return
  }

  if (text.includes("Loading Maintain Flow")) {
    const message = `${path} still returns the app loading shell to non-JS fetches`
    if (strictProtectedRoutes) {
      fail(message)
    } else {
      warn(`${message}; set SMOKE_STRICT_PROTECTED_ROUTES=1 after the app-shell fallback is deployed`)
    }
    return
  }

  fail(`${path} did not show a recognizable sign-in boundary`)
}

async function request(path, init = {}) {
  const url = new URL(path, baseUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      redirect: "follow",
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": "MaintainFlowProductionSmoke/1.0",
        ...(init.headers || {}),
      },
    })
    const text = await response.text()
    return { response, text }
  } catch (error) {
    fail(`${path} request failed: ${error instanceof Error ? error.message : String(error)}`)
    return {
      response: new Response("", { status: 0, headers: { "content-type": "" } }),
      text: "",
    }
  } finally {
    clearTimeout(timeout)
  }
}

function expectStatus(path, response, expectedStatus) {
  if (response.status !== expectedStatus) {
    fail(`${path} expected HTTP ${expectedStatus}, received ${response.status}`)
  }
}

function expectContentType(path, response, expectedContentType) {
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes(expectedContentType)) {
    fail(`${path} expected ${expectedContentType}, received ${contentType || "missing content-type"}`)
  }
}

function expectIncludes(path, text, includes) {
  for (const value of includes) {
    if (!text.includes(value)) {
      fail(`${path} missing expected text: ${value}`)
    }
  }
}

function expectExcludes(path, text, excludes) {
  for (const value of excludes) {
    if (text.includes(value)) {
      fail(`${path} contains blocked text: ${value}`)
    }
  }
}

function warnExcludes(path, text, excludes) {
  for (const value of excludes) {
    if (text.includes(value)) {
      warn(`${path} contains stale text to remove on the next deployment: ${value}`)
    }
  }
}

function pass(message) {
  checks.push({ level: "OK", message })
}

function warn(message) {
  checks.push({ level: "WARN", message })
}

function fail(message) {
  checks.push({ level: "FAIL", message })
}

function normalizeBaseUrl(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withProtocol.replace(/\/+$/, "")
}
