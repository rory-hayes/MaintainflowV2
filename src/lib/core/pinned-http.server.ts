import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"

export type PinnedEndpointFetch = (
  url: URL,
  validatedAddresses: string[],
  init: RequestInit
) => Promise<Response>

export const pinnedEndpointFetch: PinnedEndpointFetch = async (url, validatedAddresses, init) => {
  const address = validatedAddresses[0]
  if (!address) {
    throw new Error("The validated endpoint address was unavailable.")
  }

  const headers = new Headers(init.headers)
  headers.set("host", url.host)
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest

  return new Promise<Response>((resolve, reject) => {
    const request = transport({
      protocol: url.protocol,
      hostname: address,
      port: url.port || undefined,
      method: init.method || "GET",
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      servername: url.protocol === "https:" ? url.hostname : undefined,
      signal: init.signal ?? undefined,
    }, (response) => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item))
        else if (value !== undefined) responseHeaders.set(name, String(value))
      }
      const status = response.statusCode ?? 502
      const body = [204, 205, 304].includes(status)
        ? null
        : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
      resolve(new Response(body, {
        status,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }))
    })

    request.once("error", reject)
    if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.write(init.body)
    }
    request.end()
  })
}
