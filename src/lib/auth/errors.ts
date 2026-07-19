const supabaseErrorMap: Array<{ match: RegExp; message: string }> = [
  {
    match: /invalid login credentials|email not confirmed/i,
    message: "Email or password was not accepted. Check the address, password, and whether the confirmation email has been completed.",
  },
  {
    match: /supabase did not return a user for this signup/i,
    message: "Account created. Check your email for the Maintain Flow confirmation link, then log in.",
  },
  {
    match: /user already registered|already registered|already exists/i,
    message: "An account already exists for that email. Log in instead, or reset the password.",
  },
  {
    match: /signup.*disabled|signups.*disabled|email provider is disabled/i,
    message: "Email signup is not enabled for this Maintain Flow workspace. Contact the workspace owner or use Google sign-in if configured.",
  },
  {
    match: /invalid email|email.*invalid/i,
    message: "Use a real deliverable email address that can receive the Maintain Flow confirmation email.",
  },
  {
    match: /rate limit|too many requests|over email send rate limit/i,
    message: "Too many signup attempts were made. Wait a few minutes, then try again with a real email address.",
  },
  {
    match: /password/i,
    message: "Use a stronger password with 6 or more characters.",
  },
]

export const SIGNUP_CONFIRMATION_MESSAGE =
  "Account created. Check your email for the Maintain Flow confirmation link, then log in."

export class SignupConfirmationRequiredError extends Error {
  constructor() {
    super(SIGNUP_CONFIRMATION_MESSAGE)
    this.name = "SignupConfirmationRequiredError"
  }
}

export function isSignupConfirmationRequired(error: unknown): error is Error {
  return error instanceof SignupConfirmationRequiredError ||
    (error instanceof Error && /Account created\. Check your email/i.test(error.message))
}

export function toActionableAuthError(message: string, fallback = "Authentication failed.") {
  const source = message.trim() || fallback
  const mapped = supabaseErrorMap.find((item) => item.match.test(source))

  return mapped?.message ?? source
}
