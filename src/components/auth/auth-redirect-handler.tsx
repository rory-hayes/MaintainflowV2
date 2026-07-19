"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { safeAuthNextPath } from "@/lib/auth/next-path"
import { hasSupabaseAuthRedirect } from "@/lib/supabase/auth"
import { getSupabaseConfig } from "@/lib/supabase/config"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

export function AuthRedirectHandler() {
  const router = useRouter()
  const { completeOAuthSignIn } = useAuth()

  useEffect(() => {
    if (!getSupabaseConfig().enabled || !hasSupabaseAuthRedirect(window.location)) {
      return
    }

    let cancelled = false
    const searchParams = new URLSearchParams(window.location.search)
    const nextParam = searchParams.get("next")
    const nextPath = safeAuthNextPath(nextParam, "/projects")

    completeOAuthSignIn(window.location)
      .then(() => {
        if (cancelled) return
        window.history.replaceState(null, "", window.location.pathname)
        router.replace(nextPath)
      })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : "Authentication could not be completed."
        window.history.replaceState(null, "", window.location.pathname)
        router.replace(`/sign-in?authError=${encodeURIComponent(message)}`)
      })

    return () => {
      cancelled = true
    }
  }, [completeOAuthSignIn, router])

  return null
}
