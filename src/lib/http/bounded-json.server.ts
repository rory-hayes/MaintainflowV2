export class BoundedJsonRequestError extends Error {
  readonly status: 400 | 413 | 415

  constructor(
    status: 400 | 413 | 415,
    message: string,
  ) {
    super(message)
    this.name = "BoundedJsonRequestError"
    this.status = status
  }
}

export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("A positive JSON byte limit is required.")
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new BoundedJsonRequestError(415, "Send this request as JSON.")
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new BoundedJsonRequestError(413, "The request body is too large.")
  }
  const rawBody = await request.text().catch(() => "")
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    throw new BoundedJsonRequestError(413, "The request body is too large.")
  }
  try {
    return JSON.parse(rawBody)
  } catch {
    throw new BoundedJsonRequestError(400, "The request body is not valid JSON.")
  }
}

export async function readOptionalBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("A positive JSON byte limit is required.")
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new BoundedJsonRequestError(413, "The request body is too large.")
  }
  const rawBody = await request.text().catch(() => "")
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    throw new BoundedJsonRequestError(413, "The request body is too large.")
  }
  if (!rawBody.trim()) return {}
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new BoundedJsonRequestError(415, "Send this request as JSON.")
  }
  try {
    return JSON.parse(rawBody)
  } catch {
    throw new BoundedJsonRequestError(400, "The request body is not valid JSON.")
  }
}
