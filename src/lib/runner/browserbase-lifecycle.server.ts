import "server-only"

import type Browserbase from "@browserbasehq/sdk"

export async function requestBrowserbaseSessionReleaseIfStranded(
  client: Browserbase,
  sessionId: string,
  expectedProjectId?: string
) {
  let session
  try {
    session = await client.sessions.retrieve(sessionId)
  } catch (error) {
    if (browserbaseProviderStatus(error) === 404) return
    throw new Error("Browserbase could not verify that the short-lived session ended securely.")
  }
  if (expectedProjectId && session.projectId !== expectedProjectId) {
    throw new Error("The Browserbase session belongs to a different reviewed project.")
  }
  if (session.status !== "PENDING" && session.status !== "RUNNING") return
  await client.sessions.update(sessionId, { status: "REQUEST_RELEASE", projectId: session.projectId }).catch(() => {
    throw new Error("Browserbase could not release the stranded short-lived session securely.")
  })
}

export async function deleteBrowserbaseContext(client: Browserbase, contextId: string, expectedProjectId?: string) {
  try {
    if (expectedProjectId) {
      const context = await client.contexts.retrieve(contextId)
      if (context.projectId !== expectedProjectId) {
        throw new Error("The Browserbase Context belongs to a different reviewed project.")
      }
    }
    await client.contexts.delete(contextId)
  } catch (error) {
    if (browserbaseProviderStatus(error) === 404) return
    if (error instanceof Error && error.message.includes("different reviewed project")) throw error
    throw new Error("Browserbase could not delete the run-scoped Context securely.")
  }
}

function browserbaseProviderStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : null
}
