"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { Spinner } from "@/components/ui/spinner"
import { useRouter } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import { probeBusinessEvalsAccess } from "./api-adapters"

export function LegacyRouteRedirect({ destination, children }: { destination: string; children: ReactNode }) {
  const { ready, user } = useAuth()
  const router = useRouter()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (!ready) return
    if (!user) {
      setChecking(false)
      return
    }
    let active = true
    probeBusinessEvalsAccess()
      .then((access) => {
        if (!active) return
        if (access.enabled) router.replace(destination)
        else setChecking(false)
      })
      .catch(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [destination, ready, router, user])

  if (!ready || checking) return <main className="flex min-h-dvh items-center justify-center bg-[#fbfaf7]"><span className="flex items-center gap-2 text-sm text-slate-500"><Spinner className="size-4" />Checking workspace access</span></main>
  return children
}
