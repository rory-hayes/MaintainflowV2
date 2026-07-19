import "server-only"

import { bearerToken } from "@/lib/supabase/report-download.server"
import { supabaseServiceJson } from "@/lib/supabase/server"
import { getSupabaseUserAuthConfig, verifySupabaseAccessToken } from "@/lib/supabase/user-auth"
import { isBusinessEvalsWorkspaceEnabled } from "@/lib/features/business-evals"

export type WorkspaceRole = "owner" | "admin" | "member"

export type BusinessEvalsAuth = {
  token: string
  user: { id: string; email: string }
  workspace: { id: string; role: WorkspaceRole }
}

type MembershipRow = {
  agency_id: string
  role: WorkspaceRole
}

export class BusinessEvalsApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "BusinessEvalsApiError"
    this.status = status
    this.code = code
  }
}

export async function requireBusinessEvalsAuth(
  request: Request,
  options: { roles?: WorkspaceRole[]; featureGate?: boolean; allowImplicitWorkspace?: boolean } = {}
): Promise<BusinessEvalsAuth> {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) {
    throw new BusinessEvalsApiError(401, "AUTH_REQUIRED", "Sign in to continue.")
  }

  const config = getSupabaseUserAuthConfig()
  if (!config.enabled) {
    throw new BusinessEvalsApiError(503, "AUTH_NOT_CONFIGURED", "Workspace APIs require Supabase authentication.")
  }

  let user: { id: string; email: string }
  try {
    user = await verifySupabaseAccessToken(token, config)
  } catch (error) {
    throw new BusinessEvalsApiError(
      401,
      "INVALID_SESSION",
      error instanceof Error ? error.message : "Sign in again to continue."
    )
  }

  const requestedWorkspaceId = request.headers.get("x-maintainflow-workspace-id")?.trim() ?? ""
  if (!requestedWorkspaceId && !options.allowImplicitWorkspace) {
    throw new BusinessEvalsApiError(400, "WORKSPACE_REQUIRED", "Select a workspace before using Business Evals.")
  }
  const membershipPath = requestedWorkspaceId
    ? `memberships?${query({
        select: "agency_id,role",
        user_id: `eq.${user.id}`,
        agency_id: `eq.${requestedWorkspaceId}`,
        limit: "1",
      })}`
    : `memberships?${query({
        select: "agency_id,role",
        user_id: `eq.${user.id}`,
        order: "created_at.asc",
        limit: "1",
      })}`

  const memberships = await supabaseServiceJson<MembershipRow[]>(membershipPath)
  const membership = memberships[0]
  if (!membership?.agency_id) {
    throw new BusinessEvalsApiError(403, "WORKSPACE_ACCESS_DENIED", "This workspace is not available to your account.")
  }

  if (options.featureGate !== false && !isBusinessEvalsWorkspaceEnabled(membership.agency_id)) {
    throw new BusinessEvalsApiError(404, "BUSINESS_EVALS_NOT_ENABLED", "Business Evals is not enabled for this workspace.")
  }

  if (options.roles?.length && !options.roles.includes(membership.role)) {
    throw new BusinessEvalsApiError(403, "ROLE_REQUIRED", "Your workspace role cannot perform this action.")
  }

  return {
    token,
    user,
    workspace: { id: membership.agency_id, role: membership.role },
  }
}

export function businessEvalsErrorResponse(error: unknown) {
  if (error instanceof BusinessEvalsApiError) {
    return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status })
  }

  if (error && typeof error === "object" && "issues" in error) {
    return Response.json(
      { ok: false, error: { code: "INVALID_REQUEST", message: "The request did not match the required contract." } },
      { status: 400 }
    )
  }

  console.error("[business-evals-api]", error)
  return Response.json(
    { ok: false, error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } },
    { status: 500 }
  )
}

export function assertUuid(value: string, label = "identifier") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BusinessEvalsApiError(400, "INVALID_ID", `A valid ${label} is required.`)
  }
  return value
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
