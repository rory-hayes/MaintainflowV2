const productionOrigin = "https://www.maintainflow.io"
const canaryOrigin = "https://maintainflow-v2.vercel.app"
const expectedPasswordMinimum = "6"

export function evaluateSupabaseAuthReadiness(env, options = {}) {
  const results = []
  const releaseStage = options.releaseStage || "launch"
  if (!new Set(["canary", "launch"]).has(releaseStage)) {
    throw new Error("releaseStage must be canary or launch")
  }
  const expectedOrigin = releaseStage === "canary" ? canaryOrigin : productionOrigin

  checkReleaseUrl(results, env.NEXT_PUBLIC_SITE_URL, "NEXT_PUBLIC_SITE_URL", expectedOrigin, releaseStage)
  checkReleaseUrl(results, env.NEXT_PUBLIC_APP_URL, "NEXT_PUBLIC_APP_URL", expectedOrigin, releaseStage)
  checkConfirmation(results, env.SUPABASE_AUTH_EMAIL_TEMPLATES_CONFIRMED, "Maintain Flow confirmation and reset email templates")
  checkConfirmation(results, env.SUPABASE_AUTH_SMTP_CONFIRMED, "verified Maintain Flow SMTP sender settings")
  checkConfirmation(results, env.SUPABASE_AUTH_REDIRECTS_CONFIRMED, "production confirmation and recovery redirect settings")
  checkConfirmation(results, env.SUPABASE_AUTH_GOOGLE_OAUTH_CONFIRMED, "hosted Google OAuth provider and isolated sign-in flow")

  const sender = (env.SUPABASE_AUTH_SMTP_SENDER || "").trim().toLowerCase()
  const senderIsMaintainFlow = /^[^\s@]+@maintainflow\.io$/.test(sender)
  results.push({
    level: senderIsMaintainFlow ? "OK" : "BLOCK",
    message: senderIsMaintainFlow
      ? `Supabase Auth sender is attested on the Maintain Flow domain (${sender})`
      : "SUPABASE_AUTH_SMTP_SENDER must name the verified @maintainflow.io sender configured in Supabase",
  })

  results.push({
    level: env.SUPABASE_AUTH_PASSWORD_MIN_LENGTH === expectedPasswordMinimum ? "OK" : "BLOCK",
    message: env.SUPABASE_AUTH_PASSWORD_MIN_LENGTH === expectedPasswordMinimum
      ? `Supabase password minimum matches the app (${expectedPasswordMinimum} characters)`
      : `SUPABASE_AUTH_PASSWORD_MIN_LENGTH must attest that Supabase is configured for ${expectedPasswordMinimum} characters`,
  })

  return results
}

function checkReleaseUrl(results, value, key, expectedOrigin, releaseStage) {
  let origin = ""
  try {
    const url = new URL(value || "")
    origin = url.pathname === "/" && !url.search && !url.hash ? url.origin : ""
  } catch {
    origin = ""
  }

  results.push({
    level: origin === expectedOrigin ? "OK" : "BLOCK",
    message: origin === expectedOrigin
      ? `${key} uses the ${releaseStage === "canary" ? "isolated V2 canary" : "canonical production"} origin`
      : `${key} must be ${expectedOrigin} for the ${releaseStage} auth and billing flows`,
  })
}

function checkConfirmation(results, value, label) {
  const confirmed = String(value || "").toLowerCase() === "true"
  results.push({
    level: confirmed ? "OK" : "BLOCK",
    message: confirmed ? `${label} are confirmed` : `${label} are not confirmed; complete the Supabase Auth approval checklist`,
  })
}
