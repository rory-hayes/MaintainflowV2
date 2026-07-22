"use client"

import { BrandMark } from "@/components/brand/brand-mark"
import { Button } from "@/components/ui/button"
import { ButtonLink } from "@/components/ui/button-link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { safeAuthNextPath } from "@/lib/auth/next-path"
import {
  captureAndScrubEmailConfirmationLocation,
  completeSupabaseEmailConfirmationFromLocation,
  type EmailConfirmationLocationSnapshot,
} from "@/lib/supabase/auth"
import { useLayoutEffect, useRef, useState } from "react"

export default function AuthConfirmPage() {
  const capturedRef = useRef(false)
  const [locationSnapshot, setLocationSnapshot] = useState<EmailConfirmationLocationSnapshot | null>(null)
  const [state, setState] = useState<"securing" | "ready" | "working" | "confirmed" | "error">("securing")
  const [message, setMessage] = useState("Maintain Flow is securing the one-time confirmation link in this browser.")
  const [signInHref, setSignInHref] = useState("/sign-in")

  useLayoutEffect(() => {
    if (capturedRef.current) return
    capturedRef.current = true

    try {
      const snapshot = captureAndScrubEmailConfirmationLocation(window.location, window.history)
      const nextPath = safeAuthNextPath(new URLSearchParams(snapshot.search).get("next"), "")
      setLocationSnapshot(snapshot)
      setSignInHref(nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/sign-in")
      setState("ready")
      setMessage("Confirm your email, then sign in normally. No application session will be saved from this link.")
    } catch {
      setState("error")
      setMessage("This confirmation link could not be secured in this browser. Start again from Maintain Flow.")
    }
  }, [])

  async function confirmEmail() {
    if (!locationSnapshot || state === "working") return

    const securedLocation = locationSnapshot
    setLocationSnapshot(null)
    setState("working")
    setMessage("Maintain Flow is confirming your email and closing the temporary provider session.")
    try {
      await completeSupabaseEmailConfirmationFromLocation(securedLocation)
      setState("confirmed")
      setMessage("Your email is confirmed. Sign in with the email and password you chose to continue.")
    } catch (error) {
      setState("error")
      setMessage(error instanceof Error ? error.message : "Email confirmation could not be completed.")
    }
  }

  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,#0065fc33,transparent_34%),linear-gradient(180deg,#111113_0%,#0b0b0d_100%)]" />
      <Card className="relative z-10 mx-auto w-full max-w-md border-border bg-background/85 shadow-2xl supports-backdrop-filter:backdrop-blur-md">
        <CardHeader>
          <div className="mb-3"><BrandMark /></div>
          <CardTitle className="text-2xl">
            {state === "securing"
              ? "Securing your link"
              : state === "ready"
                ? "Confirm your email"
                : state === "working"
                  ? "Confirming your email"
                  : state === "confirmed"
                    ? "Email confirmed"
                    : "Confirmation needs attention"}
          </CardTitle>
          <CardDescription aria-live="polite">{message}</CardDescription>
        </CardHeader>
        {state === "ready" || state === "working" ? (
          <CardContent>
            <Button type="button" disabled={state === "working"} onClick={confirmEmail}>
              {state === "working" ? "Confirming…" : "Confirm email"}
            </Button>
          </CardContent>
        ) : state === "confirmed" || state === "error" ? (
          <CardContent>
            <ButtonLink href={state === "confirmed" ? signInHref : "/sign-up"} variant={state === "confirmed" ? "default" : "outline"}>
              {state === "confirmed" ? "Continue to sign in" : "Return to sign up"}
            </ButtonLink>
          </CardContent>
        ) : null}
      </Card>
    </section>
  )
}
