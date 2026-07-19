"use client"

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query"
import { useMemo } from "react"
import { useSearchParams } from "next/navigation"
import type { ZodType } from "zod"

import { businessEvalsRequest, type ApiEnvelope } from "@/lib/api/business-evals-client"
import type { JourneyDraftInput } from "@/lib/api/business-evals-contracts"
import {
  evalRunCollectionResponseSchema,
  evalRunResponseSchema,
  incidentCollectionResponseSchema,
  incidentResponseSchema,
  journeyCollectionResponseSchema,
  journeyResponseSchema,
  projectCollectionResponseSchema,
  projectResponseSchema,
  reportCollectionResponseSchema,
  reportResponseSchema,
} from "@/lib/api/business-evals-response-schemas"
import {
  mapIncident,
  mapJourney,
  mapProject,
  mapReport,
  mapRun,
  productionHooks,
  type BusinessEvalsRow,
} from "./api-adapters"
import type {
  EvalsCollection,
  EvalsData,
  EvalsEndpointHooks,
  EvalsPaginationState,
  IncidentMutation,
  InteractiveEvalRunMode,
} from "./types"

const pageSize = 25
const queryRoot = "business-evals"
type Row = BusinessEvalsRow
type RowPage = ApiEnvelope<Row[]>

export function useRouteScopedEvals(pathname: string, workspaceId: string) {
  const client = useQueryClient()
  const searchParams = useSearchParams()
  const route = useMemo(() => classifyRoute(pathname), [pathname])
  const projectFilter = route.projectDetailId
    ? new URLSearchParams({ projectId: route.projectDetailId, includeArchived: "true" }).toString()
    : ""
  const journeyFilter = route.journeyDetailId ? new URLSearchParams({ journeyId: route.journeyDetailId }).toString() : ""
  const journeyListFilter = route.journeyList
    ? journeyQueryFilter(searchParams.get("search"), searchParams.get("status"))
    : projectFilter

  // Projects are the one small cross-route collection because the selected
  // project switcher is part of every authenticated product screen. It is
  // still cursor-paged and never replaced by a workspace-wide mirror.
  const projectPages = useResourcePages("projects", workspaceId, true, "")
  const journeyPages = useResourcePages(
    "journeys",
    workspaceId,
    route.journeyList || Boolean(route.projectDetailId),
    journeyListFilter
  )
  const runPages = useResourcePages(
    "runs",
    workspaceId,
    route.runList || Boolean(route.journeyDetailId),
    route.journeyDetailId ? journeyFilter : "",
    true
  )
  const incidentPages = useResourcePages(
    "incidents",
    workspaceId,
    route.incidentList || Boolean(route.projectDetailId),
    route.projectDetailId ? projectFilter : ""
  )
  const reportPages = useResourcePages(
    "reports",
    workspaceId,
    route.reportList || Boolean(route.projectDetailId),
    route.projectDetailId ? projectFilter : ""
  )

  const projectDetail = useDetail("projects", route.projectDetailId, workspaceId)
  const journeyDetail = useDetail("journeys", route.journeyDetailId, workspaceId)
  const runDetail = useDetail("eval-runs", route.runDetailId, workspaceId, true)
  const incidentDetail = useDetail("incidents", route.incidentDetailId, workspaceId)
  const reportDetail = useDetail("reports", route.reportDetailId, workspaceId)

  const primaryJourneyRow = journeyDetail.data?.data ?? null
  const primaryRunRow = runDetail.data?.data ?? null
  const primaryIncidentRow = incidentDetail.data?.data ?? null
  const primaryReportRow = reportDetail.data?.data ?? null
  const linkedJourneyId = stringValue(primaryRunRow?.journeyId || primaryIncidentRow?.journeyId)
  const linkedJourneyDetail = useDetail(
    "journeys",
    route.journeyDetailId ? "" : linkedJourneyId,
    workspaceId
  )
  const resolvedJourneyRow = primaryJourneyRow ?? linkedJourneyDetail.data?.data ?? null
  const latestJourneyRunId = stringValue(arrayOfRows(primaryJourneyRow?.runs)[0]?.id)
  const latestJourneyRun = useDetail(
    "eval-runs",
    route.runDetailId ? "" : latestJourneyRunId,
    workspaceId,
    true
  )
  const linkedProjectId = stringValue(
    primaryReportRow?.projectId
      || resolvedJourneyRow?.projectId
      || primaryIncidentRow?.projectId
      || primaryRunRow?.projectId
  )
  const linkedProjectDetail = useDetail(
    "projects",
    route.projectDetailId ? "" : linkedProjectId,
    workspaceId
  )

  const projectRows = mergeRows(flattenPages(projectPages.data), [
    projectDetail.data?.data,
    linkedProjectDetail.data?.data,
  ])
  const journeyRows = mergeRows(flattenPages(journeyPages.data), [resolvedJourneyRow])
  const runRows = mergeRows(flattenPages(runPages.data), [
    primaryRunRow,
    latestJourneyRun.data?.data,
  ])
  const incidentRows = mergeRows(flattenPages(incidentPages.data), [primaryIncidentRow])
  const reportRows = mergeRows(flattenPages(reportPages.data), [primaryReportRow])
  const journeyIdsByProject = new Map<string, string[]>()
  for (const row of journeyRows) {
    const projectId = stringValue(row.projectId)
    const journeyId = stringValue(row.id)
    if (!projectId || !journeyId) continue
    journeyIdsByProject.set(projectId, [...(journeyIdsByProject.get(projectId) ?? []), journeyId])
  }

  const detailedJourneyRun = primaryRunRow && stringValue(primaryRunRow.journeyId) === stringValue(resolvedJourneyRow?.id)
    ? primaryRunRow
    : latestJourneyRun.data?.data ?? null
  const data: EvalsData = {
    projects: projectRows.map((row) => mapProject(row, journeyIdsByProject.get(stringValue(row.id)) ?? [])),
    journeys: journeyRows.map((row) => mapJourney(
      row,
      stringValue(row.id) === stringValue(resolvedJourneyRow?.id) ? detailedJourneyRun : null
    )),
    runs: runRows.map(mapRun),
    incidents: incidentRows.map(mapIncident),
    reports: reportRows.map(mapReport),
  }

  const requiredQueries = [projectPages]
  if (route.journeyList || route.projectDetailId) requiredQueries.push(journeyPages)
  if (route.runList || route.journeyDetailId) requiredQueries.push(runPages)
  if (route.incidentList || route.projectDetailId) requiredQueries.push(incidentPages)
  if (route.reportList || route.projectDetailId) requiredQueries.push(reportPages)
  const detailQueries = [
    route.projectDetailId ? projectDetail : null,
    route.journeyDetailId ? journeyDetail : null,
    route.runDetailId ? runDetail : null,
    route.incidentDetailId ? incidentDetail : null,
    route.reportDetailId ? reportDetail : null,
    linkedJourneyId && !route.journeyDetailId ? linkedJourneyDetail : null,
    linkedProjectId && !route.projectDetailId ? linkedProjectDetail : null,
    latestJourneyRunId && !route.runDetailId ? latestJourneyRun : null,
  ].filter(Boolean) as Array<{ isPending: boolean; error: Error | null }>
  const allRequired = [...requiredQueries, ...detailQueries]
  const error = allRequired.find((query) => query.error)?.error ?? null

  return {
    data,
    loading: allRequired.some((query) => query.isPending),
    error,
    retry: () => client.invalidateQueries({ queryKey: [queryRoot, workspaceId] }),
    pagination: {
      projects: paginationState(projectPages),
      journeys: paginationState(journeyPages),
      runs: paginationState(runPages),
      incidents: paginationState(incidentPages),
      reports: paginationState(reportPages),
    } satisfies EvalsPaginationState,
  }
}

export function useProductionEvalsHooks(workspaceId: string): EvalsEndpointHooks {
  const client = useQueryClient()
  const operations = useMemo(() => productionHooks(workspaceId), [workspaceId])
  const invalidate = () => client.invalidateQueries({ queryKey: [queryRoot, workspaceId] })

  const createJourney = useMutation({
    mutationFn: (draft: JourneyDraftInput) => operations.createJourney(draft),
    onSuccess: invalidate,
  })
  const updateJourney = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: JourneyDraftInput }) => operations.updateJourney(id, draft),
    onSuccess: invalidate,
  })
  const runJourney = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: InteractiveEvalRunMode }) => operations.runJourney(id, mode),
    onSuccess: invalidate,
  })
  const mutateIncident = useMutation({
    mutationFn: ({ id, mutation }: { id: string; mutation: IncidentMutation }) => operations.mutateIncident(id, mutation),
    onSuccess: invalidate,
  })
  const cancelRun = useMutation({ mutationFn: operations.cancelRun, onSuccess: invalidate })
  const pauseJourney = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => operations.pauseJourney(id, reason),
    onSuccess: invalidate,
  })
  const resumeJourney = useMutation({ mutationFn: operations.resumeJourney, onSuccess: invalidate })
  const configureJourneySchedule = useMutation({
    mutationFn: ({ id, enabled, intervalMinutes }: { id: string; enabled: boolean; intervalMinutes: number }) => operations.configureJourneySchedule(id, enabled, intervalMinutes),
    onSuccess: invalidate,
  })

  return {
    createJourney: (draft) => createJourney.mutateAsync(draft),
    updateJourney: (id, draft) => updateJourney.mutateAsync({ id, draft }),
    runJourney: (id, mode) => runJourney.mutateAsync({ id, mode }),
    mutateIncident: (id, mutation) => mutateIncident.mutateAsync({ id, mutation }),
    cancelRun: (id) => cancelRun.mutateAsync(id),
    pauseJourney: (id, reason) => pauseJourney.mutateAsync({ id, reason }),
    resumeJourney: (id) => resumeJourney.mutateAsync(id),
    configureJourneySchedule: (id, enabled, intervalMinutes) => configureJourneySchedule.mutateAsync({ id, enabled, intervalMinutes }),
  }
}

function useResourcePages(
  collection: EvalsCollection,
  workspaceId: string,
  enabled: boolean,
  filter: string,
  pollActiveRuns = false
) {
  const apiResource = collection === "runs" ? "eval-runs" : collection
  return useInfiniteQuery({
    queryKey: [queryRoot, workspaceId, collection, "list", filter],
    enabled: Boolean(workspaceId && enabled),
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(pageSize) })
      if (pageParam) params.set("cursor", pageParam)
      if (filter) {
        for (const [name, value] of new URLSearchParams(filter)) params.set(name, value)
      }
      return businessEvalsRequest(
        `/api/${apiResource}?${params.toString()}`,
        collectionResponseSchema(collection),
        { workspaceId }
      )
    },
    getNextPageParam: (lastPage) => lastPage.meta?.nextCursor || undefined,
    refetchInterval: pollActiveRuns
      ? (query) => infiniteRows(query.state.data).some(isActiveRunRow) ? 2_500 : false
      : false,
  })
}

function journeyQueryFilter(search: string | null, status: string | null) {
  const params = new URLSearchParams()
  if (search?.trim()) params.set("search", search.trim())
  if (status?.trim() && status !== "all") params.set("status", status.trim())
  return params.toString()
}

function useDetail(
  resource: "projects" | "journeys" | "eval-runs" | "incidents" | "reports",
  id: string,
  workspaceId: string,
  pollActiveRun = false
) {
  return useQuery({
    queryKey: [queryRoot, workspaceId, resource, "detail", id],
    enabled: Boolean(workspaceId && id),
    queryFn: () => businessEvalsRequest(
      `/api/${resource}/${encodeURIComponent(id)}`,
      detailResponseSchema(resource),
      { workspaceId }
    ),
    refetchInterval: pollActiveRun
      ? (query) => isActiveRunRow(query.state.data?.data) ? 1_500 : false
      : false,
  })
}

function collectionResponseSchema(collection: EvalsCollection): ZodType<Row[]> {
  switch (collection) {
    case "projects": return projectCollectionResponseSchema
    case "journeys": return journeyCollectionResponseSchema
    case "runs": return evalRunCollectionResponseSchema
    case "incidents": return incidentCollectionResponseSchema
    case "reports": return reportCollectionResponseSchema
  }
}

function detailResponseSchema(
  resource: "projects" | "journeys" | "eval-runs" | "incidents" | "reports"
): ZodType<Row> {
  switch (resource) {
    case "projects": return projectResponseSchema
    case "journeys": return journeyResponseSchema
    case "eval-runs": return evalRunResponseSchema
    case "incidents": return incidentResponseSchema
    case "reports": return reportResponseSchema
  }
}

function paginationState(query: UseInfiniteQueryResult<InfiniteData<RowPage, unknown>, Error>) {
  return {
    hasMore: Boolean(query.hasNextPage),
    loadingMore: query.isFetchingNextPage,
    loadMore: async () => { await query.fetchNextPage() },
  }
}

function flattenPages(data: InfiniteData<RowPage, unknown> | undefined) {
  return data?.pages.flatMap((page) => page.data) ?? []
}

function infiniteRows(data: unknown) {
  if (!data || typeof data !== "object" || !("pages" in data)) return []
  const pages = (data as { pages?: unknown[] }).pages
  if (!Array.isArray(pages)) return []
  return pages.flatMap((page) => page && typeof page === "object" && "data" in page && Array.isArray(page.data)
    ? page.data.filter(isRow)
    : [])
}

function mergeRows(rows: Row[], extras: Array<Row | null | undefined>) {
  const merged = [...extras.filter(isRow), ...rows]
  const seen = new Set<string>()
  return merged.filter((row) => {
    const id = stringValue(row.id)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function isActiveRunRow(row: unknown) {
  if (!isRow(row)) return false
  return ["queued", "claimed", "running", "waiting_for_email"].includes(stringValue(row.status).toLowerCase())
}

function classifyRoute(pathname: string) {
  const projectDetailId = routeId(pathname, "projects")
  const journeyDetailId = routeId(pathname, "journeys")
  const runDetailId = routeId(pathname, "eval-runs")
  const incidentDetailId = routeId(pathname, "incidents")
  const reportDetailId = routeId(pathname, "reports")
  return {
    projectDetailId,
    journeyDetailId,
    runDetailId,
    incidentDetailId,
    reportDetailId,
    journeyList: pathname === "/journeys",
    runList: pathname === "/eval-runs",
    incidentList: pathname === "/incidents",
    reportList: pathname === "/reports",
  }
}

function routeId(pathname: string, prefix: string) {
  const match = pathname.match(new RegExp(`^/${prefix}/([^/]+)`))
  const id = match?.[1] ?? ""
  return id && id !== "new" ? decodeURIComponent(id) : ""
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function arrayOfRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : []
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : ""
}
