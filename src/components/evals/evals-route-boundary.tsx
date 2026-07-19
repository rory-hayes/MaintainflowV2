"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import { probeBusinessEvalsAccess } from "./api-adapters"
import { EvalsProvider } from "./evals-provider"
import { evalsSeedData } from "./seed-data"
import { useProductionEvalsHooks, useRouteScopedEvals } from "./use-route-scoped-evals"

export function EvalsRouteBoundary({ children, previewEnabled = false, disabledFallback }: { children: ReactNode; previewEnabled?: boolean; disabledFallback?: ReactNode }) {
  if (previewEnabled) return <EvalsProvider mode="preview" initialData={evalsSeedData}>{children}</EvalsProvider>
  return <ProductionEvalsBoundary disabledFallback={disabledFallback}>{children}</ProductionEvalsBoundary>
}

function ProductionEvalsBoundary({ children, disabledFallback }: { children: ReactNode; disabledFallback?: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { ready, user } = useAuth()
  const [workspaceId, setWorkspaceId] = useState("")
  const [error, setError] = useState("")
  const [disabled, setDisabled] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const routeData = useRouteScopedEvals(pathname, workspaceId)
  const hooks = useProductionEvalsHooks(workspaceId)

  useEffect(() => {
    if (!ready || !user) return
    let active = true
    setError("")
    probeBusinessEvalsAccess()
      .then((access) => {
        if (!active) return
        if (!access.enabled) {
          if (disabledFallback) setDisabled(true)
          else router.replace("/dashboard")
          return
        }
        setDisabled(false)
        setWorkspaceId(access.workspaceId)
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Business eval access could not be checked.") })
    return () => { active = false }
  }, [disabledFallback, ready, retryKey, router, user])

  if (!ready) return <BoundaryState title="Loading business evals" description="Checking your workspace session." loading />
  if (!user) return <BoundaryState title="Sign in required" description="Sign in to access this Maintain Flow workspace." action={<Button nativeButton={false} render={<Link href="/sign-in?next=%2Fprojects" />}>Sign in</Button>} />
  if (disabled && disabledFallback) return disabledFallback
  if (error) return <BoundaryState title="Business evals are unavailable" description={error} action={<Button onClick={() => setRetryKey((key) => key + 1)}>Try again</Button>} />
  if (!workspaceId) return <BoundaryState title="Loading business evals" description="Loading tenant-scoped projects, journeys and evidence." loading />
  if (routeData.error) return <BoundaryState title="Business evals are unavailable" description={routeData.error.message} action={<Button onClick={() => void routeData.retry()}>Try again</Button>} />
  if (routeData.loading) return <BoundaryState title="Loading business evals" description="Loading only the tenant-scoped records needed for this page." loading />
  return <EvalsProvider initialData={routeData.data} hooks={hooks} pagination={routeData.pagination} workspaceId={workspaceId}>{children}</EvalsProvider>
}

function BoundaryState({ title, description, loading = false, action }: { title: string; description: string; loading?: boolean; action?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#fbfaf7] p-5">
      <Card className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-sm ring-0">
        <CardHeader><CardTitle>{title}</CardTitle><CardDescription className="leading-6">{description}</CardDescription></CardHeader>
        <CardContent>{loading ? <div className="flex items-center gap-2 text-sm text-slate-600"><Spinner className="size-4" />Please wait</div> : action}</CardContent>
      </Card>
    </main>
  )
}
