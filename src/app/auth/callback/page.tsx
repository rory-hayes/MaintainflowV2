"use client"

import { BrandMark } from "@/components/brand/brand-mark"
import { useAuth } from "@/components/auth/auth-provider"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ButtonLink } from "@/components/ui/button-link"
import { safeAuthNextPath } from "@/lib/auth/next-path"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"

export default function AuthCallbackPage() {
  const router = useRouter()
  const { completeOAuthSignIn } = useAuth()
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)
    const nextParam = params.get("next")
    const nextPath = safeAuthNextPath(nextParam, "/projects")

    completeOAuthSignIn(window.location)
      .then(() => {
        if (!cancelled) {
          router.replace(nextPath)
        }
      })
      .catch((callbackError) => {
        if (!cancelled) {
          setError(callbackError instanceof Error ? callbackError.message : "Google sign-in failed.")
        }
      })

    return () => {
      cancelled = true
    }
  }, [completeOAuthSignIn, router])

  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,#0065fc33,transparent_34%),linear-gradient(180deg,#111113_0%,#0b0b0d_100%)]" />
      <Card className="relative z-10 mx-auto w-full max-w-md border-border bg-background/85 shadow-2xl supports-backdrop-filter:backdrop-blur-md">
        <CardHeader>
          <div className="mb-3">
            <BrandMark />
          </div>
          <CardTitle className="text-2xl">{error ? "Google sign-in needs attention" : "Finishing sign-in"}</CardTitle>
          <CardDescription>
            {error || "Maintain Flow is securely completing your Google session."}
          </CardDescription>
        </CardHeader>
        {error ? (
          <CardContent>
            <ButtonLink href="/sign-in" variant="outline">Return to sign in</ButtonLink>
          </CardContent>
        ) : null}
      </Card>
    </section>
  )
}
