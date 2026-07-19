export type EmailValidationResult =
  | { ok: true; email: string }
  | { ok: false; message: string }

const blockedExactDomains = new Set(["example.com", "example.net", "example.org", "test.com"])
const blockedTlds = new Set(["test", "example", "invalid", "localhost"])

export function normalizeEmailAddress(email: string) {
  return email.trim().toLowerCase()
}

export function validateDeliverableEmail(emailInput: string): EmailValidationResult {
  const email = normalizeEmailAddress(emailInput)

  if (!email) {
    return { ok: false, message: "Use a real email address that can receive the Maintain Flow confirmation email." }
  }

  const basicEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!basicEmailPattern.test(email)) {
    return { ok: false, message: "Enter a valid email address, like ops@youragency.com." }
  }

  const [, domain = ""] = email.split("@")
  const labels = domain.split(".")
  const tld = labels.at(-1) ?? ""

  if (blockedExactDomains.has(domain) || blockedTlds.has(tld) || domain.endsWith(".test") || domain.endsWith(".localhost")) {
    return { ok: false, message: "Use a real deliverable email address. Test, example, and localhost domains cannot receive signup emails." }
  }

  return { ok: true, email }
}
