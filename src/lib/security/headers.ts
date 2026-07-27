type SecurityHeaderEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_AUTH_URL?: string
  NEXT_PUBLIC_SENTRY_DSN?: string
}

export type SecurityHeader = {
  key: string
  value: string
}

export function buildProductionSecurityHeaders(
  environment: SecurityHeaderEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_AUTH_URL: process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  }
): SecurityHeader[] {
  const supabaseOrigins = [
    validHttpsOrigin(environment.NEXT_PUBLIC_SUPABASE_URL),
    validHttpsOrigin(environment.NEXT_PUBLIC_SUPABASE_AUTH_URL),
  ].filter((value): value is string => Boolean(value))
  const providerOrigins = unique([
    ...supabaseOrigins,
    validHttpsOrigin(environment.NEXT_PUBLIC_SENTRY_DSN),
  ].filter((value): value is string => Boolean(value)))
  const providerSocketOrigins = unique(
    supabaseOrigins.map((origin) => origin.replace(/^https:/, "wss:"))
  )
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabaseOrigins.join(" ")}`,
    "font-src 'self' data:",
    `connect-src 'self' ${[...providerOrigins, ...providerSocketOrigins].join(" ")}`,
    "frame-src 'self' https://accounts.google.com https://*.stripe.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ")

  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=(), clipboard-write=(self)",
    },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Strict-Transport-Security", value: "max-age=63072000" },
  ]
}

function validHttpsOrigin(value: string | undefined) {
  if (!value) return null

  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.origin : null
  } catch {
    return null
  }
}

function unique(values: string[]) {
  return [...new Set(values)]
}
