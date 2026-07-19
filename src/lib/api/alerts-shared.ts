const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function normalizeAlertEmail(value: string) {
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    || /[\r\n]/.test(normalized)
  ) {
    throw new Error("Enter a valid alert email address.")
  }
  return normalized
}

export function alertTargetPreview(kind: "email" | "webhook", destination: string) {
  if (kind === "email") {
    const [local, domain] = destination.split("@")
    return `${local.slice(0, 1)}***@${domain}`
  }
  const url = new URL(destination)
  return `${url.origin}/…`
}

export function safeAlertText(value: unknown, fallback: string, maximumLength = 500) {
  const normalized = String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
  return (normalized || fallback).slice(0, maximumLength)
}

export function alertEmailMessage(input: {
  eventId: string
  eventType: string
  status: string
  summary: string
  dashboardUrl: string
}) {
  const eventLabel = input.eventType.replaceAll("_", " ").replaceAll(".", " — ")
  return {
    subject: `Maintain Flow: ${safeAlertText(eventLabel, "Business eval update", 120)}`,
    text: [
      "Maintain Flow business eval update",
      "",
      `Status: ${safeAlertText(input.status, "updated", 80)}`,
      safeAlertText(input.summary, "Open Maintain Flow to review this event."),
      "",
      `Review: ${input.dashboardUrl}`,
      `Event ID: ${input.eventId}`,
    ].join("\n"),
  }
}
