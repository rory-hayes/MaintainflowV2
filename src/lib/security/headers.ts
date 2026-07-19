type SecurityHeaderEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_AUTH_URL?: string
}

export type SecurityHeader = {
  key: string
  value: string
}

export function buildProductionSecurityHeaders(
  environment: SecurityHeaderEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_AUTH_URL: process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL,
  }
): SecurityHeader[] {
  const supabaseOrigins = [
    "https://*.supabase.co",
    validHttpsOrigin(environment.NEXT_PUBLIC_SUPABASE_URL),
    validHttpsOrigin(environment.NEXT_PUBLIC_SUPABASE_AUTH_URL),
  ].filter((value): value is string => Boolean(value))
  const providerOrigins = unique(supabaseOrigins)
  const navigationOrigins = unique([
    ...providerOrigins,
    "https://accounts.google.com",
    "https://checkout.stripe.com",
    "https://billing.stripe.com",
  ])
  const contentSecurityPolicyReportOnly = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `form-action 'self' ${navigationOrigins.join(" ")}`,
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${providerOrigins.join(" ")}`,
    "frame-src 'self' https://accounts.google.com https://*.stripe.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ")

  return [
    { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicyReportOnly },
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
