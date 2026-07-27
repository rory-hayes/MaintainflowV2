const QUOTED_SECRET_PATTERN = /(\b(?:api[_-]?key|token|password|secret|authorization)\b["']?\s*[=:]\s*)(["'])(?:\\.|(?!\2).)*\2/gi
const SECRET_PATTERN = /(?:bearer\s+|["']?(?:api[_-]?key|token|password|secret|authorization)["']?\s*[=:]\s*)[^\s,"'};&]+|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+|sk-proj-[A-Za-z0-9_-]+|re_[A-Za-z0-9_-]{12,}/gi
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const URL_QUERY_PATTERN = /(https?:\/\/[^\s?#]+)[?#][^\s]*/gi

export function redactObservabilityText(value: string | undefined) {
  if (!value) return value
  return value
    .replace(QUOTED_SECRET_PATTERN, "$1[redacted]")
    .replace(SECRET_PATTERN, "[redacted]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(URL_QUERY_PATTERN, "$1")
    .slice(0, 1_000)
}

type SentryLikeEvent = {
  user?: unknown
  request?: { method?: string }
  message?: string
  transaction?: string
  culprit?: string
  tags?: Record<string, unknown>
  fingerprint?: string[]
  modules?: Record<string, string>
  server_name?: string
  spans?: unknown[]
  logentry?: { message?: string; formatted?: string; params?: unknown[] }
  exception?: { values?: Array<{ type?: string; value?: string; stacktrace?: { frames?: FrameLike[] }; mechanism?: unknown }> }
  threads?: { values?: Array<{ crashed?: boolean; current?: boolean; stacktrace?: { frames?: FrameLike[] } }> }
  breadcrumbs?: Array<{ type?: string; level?: string; timestamp?: number; category?: string; message?: string; data?: unknown }>
  contexts?: Record<string, unknown>
  extra?: Record<string, unknown>
}

type FrameLike = {
  function?: string
  module?: string
  filename?: string
  abs_path?: string
  lineno?: number
  colno?: number
  in_app?: boolean
  vars?: unknown
  context_line?: string
  pre_context?: string[]
  post_context?: string[]
}

export function scrubSentryEvent<T extends SentryLikeEvent>(event: T): T {
  delete event.user
  delete event.transaction
  delete event.culprit
  delete event.tags
  delete event.fingerprint
  delete event.modules
  delete event.server_name
  delete event.spans
  if (event.message) event.message = "Application error (details withheld)"
  if (event.request) event.request = { method: event.request.method }
  if (event.logentry) {
    event.logentry = {
      message: event.logentry.message ? "Application error (details withheld)" : undefined,
      formatted: event.logentry.formatted ? "Application error (details withheld)" : undefined,
      params: undefined,
    }
  }
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((value) => ({
      type: value.type ? "ApplicationError" : undefined,
      value: value.value ? "Exception details withheld" : undefined,
      ...(value.stacktrace ? { stacktrace: scrubStacktrace(value.stacktrace) } : {}),
    }))
  }
  if (event.threads?.values) {
    event.threads.values = event.threads.values.map((thread) => ({
      crashed: typeof thread.crashed === "boolean" ? thread.crashed : undefined,
      current: typeof thread.current === "boolean" ? thread.current : undefined,
      ...(thread.stacktrace ? { stacktrace: scrubStacktrace(thread.stacktrace) } : {}),
    }))
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.slice(-30).map((breadcrumb) => ({
      type: safeBreadcrumbType(breadcrumb.type),
      level: safeBreadcrumbLevel(breadcrumb.level),
      timestamp: typeof breadcrumb.timestamp === "number" && Number.isFinite(breadcrumb.timestamp)
        ? breadcrumb.timestamp
        : undefined,
      category: "application",
      message: breadcrumb.message ? "Breadcrumb details withheld" : undefined,
    }))
  }
  delete event.extra
  delete event.contexts
  return event
}

function scrubStacktrace(stacktrace: { frames?: FrameLike[] }) {
  return {
    frames: stacktrace.frames?.map((frame) => ({
      function: typeof frame.function === "string" ? redactObservabilityText(frame.function) : undefined,
      module: typeof frame.module === "string" ? redactObservabilityText(frame.module) : undefined,
      lineno: typeof frame.lineno === "number" ? frame.lineno : undefined,
      colno: typeof frame.colno === "number" ? frame.colno : undefined,
      in_app: typeof frame.in_app === "boolean" ? frame.in_app : undefined,
    })),
  }
}

function safeBreadcrumbType(value: unknown) {
  return typeof value === "string" && new Set(["default", "debug", "error", "http", "info", "navigation", "query", "transaction", "ui", "user"]).has(value)
    ? value
    : undefined
}

function safeBreadcrumbLevel(value: unknown) {
  return typeof value === "string" && new Set(["debug", "info", "warning", "error", "fatal"]).has(value)
    ? value
    : undefined
}
