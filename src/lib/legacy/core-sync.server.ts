import "server-only"

import { BusinessEvalsApiError } from "@/lib/api/business-evals-auth.server"
import { getBusinessEvalsEntitlement } from "@/lib/api/business-evals-entitlements.server"
import { assertSavedMonitorPolicy } from "@/lib/core/saved-monitor-policy"
import type {
  LegacyClientRow,
  LegacyCoreSyncRequest,
  LegacyWorkflowRow,
} from "@/lib/legacy/core-sync-contract"
import { supabaseServiceJson } from "@/lib/supabase/server"

type Row = Record<string, unknown>

export async function applyLegacyCoreSync(input: {
  agencyId: string
  userId: string
  request: LegacyCoreSyncRequest
}) {
  assertRequestTenancy(input.agencyId, input.request)
  const entitlement = input.request.creates.length
    ? await getBusinessEvalsEntitlement(input.agencyId)
    : null

  if (input.request.table === "clients") {
    const created = [] as string[]
    const updated = [] as string[]
    for (const row of input.request.creates) {
      await createLegacyClient(input.agencyId, input.userId, row, entitlement?.projectLimit ?? null)
      created.push(row.id)
    }
    for (const update of input.request.updates) {
      await updateLegacyClient(input.agencyId, update.row, update.expectedUpdatedAt)
      updated.push(update.row.id)
    }
    return { table: input.request.table, created, updated }
  }

  const created = [] as string[]
  const updated = [] as string[]
  for (const row of input.request.creates) {
    await createLegacyWorkflow(input.agencyId, row, entitlement?.journeyLimit ?? null)
    created.push(row.id)
  }
  for (const update of input.request.updates) {
    await updateLegacyWorkflow(input.agencyId, update.row, update.expectedUpdatedAt)
    updated.push(update.row.id)
  }
  return { table: input.request.table, created, updated }
}

function assertRequestTenancy(agencyId: string, request: LegacyCoreSyncRequest) {
  const rows = [...request.creates, ...request.updates.map((update) => update.row)]
  if (rows.some((row) => row.agency_id !== agencyId)) {
    throw new BusinessEvalsApiError(403, "LEGACY_SYNC_TENANT_MISMATCH", "Legacy rows must belong to the selected workspace.")
  }
}

async function createLegacyClient(
  agencyId: string,
  actorUserId: string,
  row: LegacyClientRow,
  projectLimit: number | null
) {
  const ownerUserId = row.owner_user_id ?? actorUserId
  const expectedCreate = {
    agency_id: agencyId,
    project_kind: "client_site",
    ...legacyClientPatch(row),
    owner_user_id: ownerUserId,
  }
  const existing = await findRowById("clients", row.id, "*")
  if (existing) {
    if (!rowMatchesPatch(existing, expectedCreate)) {
      throw new BusinessEvalsApiError(409, "LEGACY_SYNC_ID_CONFLICT", "The legacy client identifier is already in use.")
    }
    return
  }

  await assertWorkspaceMember(agencyId, ownerUserId)
  try {
    if (row.archived_at) {
      await supabaseServiceJson<Row[]>("clients?on_conflict=id", {
        method: "POST",
        prefer: "return=representation",
        body: JSON.stringify({
          ...legacyClientInsert(row, ownerUserId),
          project_kind: "client_site",
        }),
      })
    } else {
      await supabaseServiceJson<Row[]>("rpc/create_business_eval_project", {
        method: "POST",
        body: JSON.stringify({
          p_agency_id: agencyId,
          p_project_limit: projectLimit,
          p_project_id: row.id,
          p_name: row.name,
          p_slug: row.slug,
          p_website: row.website,
          p_project_kind: "client_site",
          p_owner_user_id: ownerUserId,
          p_report_recipient_email: row.report_recipient_email ?? "",
          p_notes: row.notes,
        }),
      })
      if (row.report_cadence !== "monthly") {
        await supabaseServiceJson(`clients?${query({
          agency_id: `eq.${agencyId}`,
          id: `eq.${row.id}`,
        })}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: JSON.stringify({ report_cadence: row.report_cadence }),
        })
      }
    }
  } catch (error) {
    throw translateLegacyLimitError(error, "project")
  }
}

async function updateLegacyClient(agencyId: string, row: LegacyClientRow, expectedUpdatedAt: string) {
  const current = await findScopedRow("clients", agencyId, row.id)
  if (!current) {
    throw new BusinessEvalsApiError(404, "LEGACY_CLIENT_NOT_FOUND", "Legacy client not found.")
  }
  const patch = legacyClientPatch(row)
  if (String(current.updated_at) !== expectedUpdatedAt) {
    if (rowMatchesPatch(current, patch)) return
    throw legacyWriteConflict("clients")
  }
  if (current.archived_at && !row.archived_at) {
    throw new BusinessEvalsApiError(409, "LEGACY_RESTORE_UNSUPPORTED", "Restore archived projects from the Projects interface.")
  }
  if (row.owner_user_id) await assertWorkspaceMember(agencyId, row.owner_user_id)

  if (String(current.website ?? "") !== row.website || nullableString(current.archived_at) !== row.archived_at) {
    await supabaseServiceJson("rpc/revoke_project_authorizations_and_pause", {
      method: "POST",
      body: JSON.stringify({ p_agency_id: agencyId, p_client_id: row.id }),
    })
  }
  const changed = await supabaseServiceJson<Row[]>(`clients?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${row.id}`,
    updated_at: `eq.${expectedUpdatedAt}`,
    select: "id",
  })}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
  if (changed.length !== 1) throw legacyWriteConflict("clients")
}

async function createLegacyWorkflow(agencyId: string, row: LegacyWorkflowRow, journeyLimit: number | null) {
  assertLegacyWorkflowPolicy(row)
  const expectedCreate = {
    agency_id: agencyId,
    client_id: row.client_id,
    ...legacyWorkflowPatch(row),
    status: row.archived_at ? "archived" : "pending",
    health_score: 0,
    last_check_run_at: null,
    journey_template: "legacy_endpoint",
    draft_definition_json: {},
    draft_revision: 0,
    paused_at: null,
    pause_reason: "",
  }
  const existing = await findRowById("workflows", row.id, "*")
  if (existing) {
    if (!rowMatchesPatch(existing, expectedCreate)) {
      throw new BusinessEvalsApiError(409, "LEGACY_SYNC_ID_CONFLICT", "The legacy workflow identifier is already in use.")
    }
    return
  }
  await assertProjectInWorkspace(agencyId, row.client_id, Boolean(row.archived_at))
  try {
    if (row.archived_at) {
      await supabaseServiceJson<Row[]>("workflows?on_conflict=id", {
        method: "POST",
        body: JSON.stringify(legacyWorkflowInsert(row)),
      })
    } else {
      await supabaseServiceJson<Row[]>("rpc/create_legacy_endpoint_workflow", {
        method: "POST",
        body: JSON.stringify({
          p_agency_id: agencyId,
          p_journey_limit: journeyLimit,
          p_workflow_id: row.id,
          p_client_id: row.client_id,
          p_name: row.name,
          p_type: row.type,
          p_environment: row.environment,
          p_endpoint_url: row.endpoint_url,
          p_expected_status: row.expected_status,
          p_timeout_seconds: row.timeout_seconds,
          p_max_latency_ms: row.max_latency_ms,
          p_frequency_minutes: row.frequency_minutes,
          p_retries: row.retries,
          p_report_included: row.report_included,
          p_archived_at: null,
        }),
      })
    }
  } catch (error) {
    throw translateLegacyLimitError(error, "journey")
  }
}

async function updateLegacyWorkflow(agencyId: string, row: LegacyWorkflowRow, expectedUpdatedAt: string) {
  assertLegacyWorkflowPolicy(row)
  const current = await findScopedRow("workflows", agencyId, row.id)
  if (!current || String(current.journey_template ?? "legacy_endpoint") !== "legacy_endpoint") {
    throw new BusinessEvalsApiError(404, "LEGACY_WORKFLOW_NOT_FOUND", "Legacy endpoint workflow not found.")
  }
  if (String(current.client_id) !== row.client_id) {
    throw new BusinessEvalsApiError(409, "LEGACY_WORKFLOW_REPARENT_BLOCKED", "Legacy endpoint workflows cannot be moved between projects.")
  }
  const patch = legacyWorkflowPatch(row)
  if (String(current.updated_at) !== expectedUpdatedAt) {
    if (rowMatchesPatch(current, patch)) return
    throw legacyWriteConflict("workflows")
  }
  if (current.archived_at && !row.archived_at) {
    throw new BusinessEvalsApiError(409, "LEGACY_RESTORE_UNSUPPORTED", "Restore archived journeys from the Journeys interface.")
  }
  await assertProjectInWorkspace(agencyId, row.client_id, Boolean(row.archived_at))
  const changed = await supabaseServiceJson<Row[]>(`workflows?${query({
    agency_id: `eq.${agencyId}`,
    id: `eq.${row.id}`,
    journey_template: "eq.legacy_endpoint",
    updated_at: `eq.${expectedUpdatedAt}`,
    select: "id",
  })}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
  if (changed.length !== 1) throw legacyWriteConflict("workflows")
}

function legacyClientInsert(row: LegacyClientRow, ownerUserId: string) {
  return {
    id: row.id,
    agency_id: row.agency_id,
    ...legacyClientPatch(row),
    owner_user_id: ownerUserId,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function legacyClientPatch(row: LegacyClientRow) {
  return {
    name: row.name,
    slug: row.slug,
    website: row.website,
    owner_user_id: row.owner_user_id,
    report_recipient_email: row.report_recipient_email,
    report_cadence: row.report_cadence,
    notes: row.notes,
    archived_at: row.archived_at,
  }
}

function legacyWorkflowInsert(row: LegacyWorkflowRow) {
  return {
    id: row.id,
    agency_id: row.agency_id,
    client_id: row.client_id,
    ...legacyWorkflowPatch(row),
    status: row.archived_at ? "archived" : "pending",
    health_score: 0,
    last_check_run_at: null,
    journey_template: "legacy_endpoint",
    draft_definition_json: {},
    draft_revision: 0,
    paused_at: null,
    pause_reason: "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function legacyWorkflowPatch(row: LegacyWorkflowRow) {
  return {
    name: row.name,
    type: row.type,
    environment: row.environment,
    endpoint_url: row.endpoint_url,
    method: "GET",
    auth_type: "none",
    encrypted_auth_config: { headers: [] },
    request_body: "",
    expected_status: row.expected_status,
    timeout_seconds: row.timeout_seconds,
    max_latency_ms: row.max_latency_ms,
    frequency_minutes: row.frequency_minutes,
    retries: row.retries,
    report_included: row.report_included,
    store_raw_response: false,
    archived_at: row.archived_at,
  }
}

function assertLegacyWorkflowPolicy(row: LegacyWorkflowRow) {
  try {
    assertSavedMonitorPolicy({
      endpointUrl: row.endpoint_url,
      method: row.method,
      headers: {},
      requestBody: row.request_body,
    }, { allowEmptyEndpoint: true })
  } catch (error) {
    throw new BusinessEvalsApiError(
      400,
      "LEGACY_MONITOR_INVALID",
      error instanceof Error ? error.message : "The legacy endpoint configuration is not supported."
    )
  }
}

async function assertWorkspaceMember(agencyId: string, userId: string) {
  const rows = await supabaseServiceJson<Row[]>(`memberships?${query({
    select: "user_id",
    agency_id: `eq.${agencyId}`,
    user_id: `eq.${userId}`,
    limit: "1",
  })}`)
  if (!rows[0]) {
    throw new BusinessEvalsApiError(400, "OWNER_NOT_IN_WORKSPACE", "The legacy client owner must be a workspace member.")
  }
}

async function assertProjectInWorkspace(agencyId: string, clientId: string, allowArchived: boolean) {
  const filters: Record<string, string> = {
    select: "id",
    agency_id: `eq.${agencyId}`,
    id: `eq.${clientId}`,
    limit: "1",
  }
  if (!allowArchived) filters.archived_at = "is.null"
  const rows = await supabaseServiceJson<Row[]>(`clients?${query(filters)}`)
  if (!rows[0]) {
    throw new BusinessEvalsApiError(404, "PROJECT_NOT_FOUND", "The legacy endpoint project is unavailable.")
  }
}

async function findRowById(table: "clients" | "workflows", id: string, select: string) {
  const rows = await supabaseServiceJson<Row[]>(`${table}?${query({ select, id: `eq.${id}`, limit: "1" })}`)
  return rows[0] ?? null
}

async function findScopedRow(table: "clients" | "workflows", agencyId: string, id: string) {
  const rows = await supabaseServiceJson<Row[]>(`${table}?${query({
    select: "*",
    agency_id: `eq.${agencyId}`,
    id: `eq.${id}`,
    limit: "1",
  })}`)
  return rows[0] ?? null
}

function rowMatchesPatch(row: Row, patch: Record<string, unknown>) {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(row[key] ?? null) === JSON.stringify(value ?? null))
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null
}

function legacyWriteConflict(table: "clients" | "workflows") {
  return new BusinessEvalsApiError(409, "LEGACY_WRITE_CONFLICT", `${table} changed in another session. Reload and try again.`)
}

function translateLegacyLimitError(error: unknown, resource: "project" | "journey") {
  if (error instanceof BusinessEvalsApiError) return error
  if (error instanceof Error && error.message.includes(resource === "project" ? "PROJECT_LIMIT_REACHED" : "JOURNEY_LIMIT_REACHED")) {
    return new BusinessEvalsApiError(
      409,
      resource === "project" ? "PROJECT_LIMIT_REACHED" : "JOURNEY_LIMIT_REACHED",
      `The current plan has reached its active ${resource} limit.`
    )
  }
  return error
}

function query(params: Record<string, string>) {
  return new URLSearchParams(params).toString()
}
