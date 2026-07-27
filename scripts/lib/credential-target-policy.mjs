const canaryOrigin = "https://maintainflow-v2.vercel.app"
const productionOrigin = "https://www.maintainflow.io"
const localOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
])

export function validateCredentialBearingAppOrigin(value, options = {}) {
  const label = options.label || "Application URL"
  const origin = exactRootOrigin(value)
  const approved = new Set([canaryOrigin, productionOrigin])
  if (options.allowLocal) {
    for (const localOrigin of localOrigins) approved.add(localOrigin)
  }

  if (!origin || !approved.has(origin)) {
    const expected = [...approved].join(", ")
    throw new Error(`${label} must be an exact approved root origin before a credential can be sent. Expected one of: ${expected}.`)
  }

  return origin
}

function exactRootOrigin(value) {
  try {
    const url = new URL(String(value || "").trim())
    if (
      url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")
    ) return null
    return url.origin
  } catch {
    return null
  }
}
