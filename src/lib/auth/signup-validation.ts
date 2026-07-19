import { validateDeliverableEmail } from "./email.ts"

export const AUTH_PASSWORD_MIN_LENGTH = 6

export const signupFieldOrder = ["name", "company", "role", "email", "password"] as const

export type SignupField = (typeof signupFieldOrder)[number]

export type SignupInput = {
  name: string
  company: string
  role: string
  email: string
  password: string
}

export type SignupFieldErrors = Partial<Record<SignupField, string>>

export type SignupValidationResult =
  | { ok: true; value: SignupInput }
  | { ok: false; errors: SignupFieldErrors }

export function validateSignupInput(input: SignupInput): SignupValidationResult {
  const name = input.name.trim()
  const company = input.company.trim()
  const role = input.role.trim()
  const emailValidation = validateDeliverableEmail(input.email)
  const errors: SignupFieldErrors = {}

  if (!name) errors.name = "Enter your name."
  if (!company) errors.company = "Enter your company or team name."
  if (!role) errors.role = "Select your role."
  if (!emailValidation.ok) errors.email = emailValidation.message
  if (input.password.length < AUTH_PASSWORD_MIN_LENGTH) {
    errors.password = `Use ${AUTH_PASSWORD_MIN_LENGTH} or more characters.`
  }

  if (Object.keys(errors).length) return { ok: false, errors }

  return {
    ok: true,
    value: {
      name,
      company,
      role,
      email: emailValidation.ok ? emailValidation.email : input.email,
      password: input.password,
    },
  }
}

export function firstInvalidSignupField(errors: SignupFieldErrors) {
  return signupFieldOrder.find((field) => Boolean(errors[field])) ?? null
}

export function firstSignupValidationMessage(errors: SignupFieldErrors) {
  const firstField = firstInvalidSignupField(errors)
  return firstField ? errors[firstField] ?? "Check the highlighted signup fields." : "Check the highlighted signup fields."
}
