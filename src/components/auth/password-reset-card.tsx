"use client"

import { BrandMark } from "@/components/brand/brand-mark"
import { authLightThemeStyle } from "@/components/auth/auth-light-theme"
import { Button } from "@/components/ui/button"
import { ButtonLink } from "@/components/ui/button-link"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { requestLocalPasswordReset, resetLocalPassword } from "@/lib/auth-storage"
import {
  currentLegalAcceptance,
  MAINTAINFLOW_PRIVACY_LAST_UPDATED,
  MAINTAINFLOW_TERMS_LAST_UPDATED,
} from "@/lib/legal/acceptance"
import {
  captureAndScrubPasswordResetLocation,
  completeSupabasePasswordResetFromLocation,
  requestSupabasePasswordReset,
  type PasswordResetLocationSnapshot,
} from "@/lib/supabase/auth"
import { getSupabaseConfig } from "@/lib/supabase/config"
import { IconArrowLeft, IconArrowRight, IconMail, IconShieldLock } from "@tabler/icons-react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { type FormEvent, useLayoutEffect, useRef, useState } from "react"

type PasswordResetCardProps = {
  mode: "forgot" | "reset"
}

export function PasswordResetCard({ mode }: PasswordResetCardProps) {
  const capturedResetRef = useRef(false)
  const searchParams = useSearchParams()
  const [submitted, setSubmitted] = useState(false)
  const [email, setEmail] = useState(searchParams.get("email") ?? "")
  const [token] = useState(searchParams.get("token") ?? "")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [resetPath, setResetPath] = useState("")
  const [error, setError] = useState("")
  const [legalAccepted, setLegalAccepted] = useState(false)
  const [legalError, setLegalError] = useState("")
  const [resetLocation, setResetLocation] = useState<PasswordResetLocationSnapshot | null>(null)
  const isReset = mode === "reset"
  const useSupabase = getSupabaseConfig().enabled

  useLayoutEffect(() => {
    if (!isReset || capturedResetRef.current) return
    capturedResetRef.current = true

    try {
      const location = captureAndScrubPasswordResetLocation(window.location, window.history)
      setResetLocation(location)
    } catch {
      setError("This password link could not be secured in this browser. Request a new link.")
    }
  }, [isReset])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setLegalError("")

    try {
      if (isReset) {
        if (useSupabase) {
          if (!resetLocation) {
            setError("This password link is not ready. Request a new link if the problem continues.")
            return
          }
          if (!legalAccepted) {
            setLegalError("Explicitly accept the current Terms and acknowledge the Privacy Policy before setting your password.")
            document.getElementById("reset-legal-consent")?.focus()
            return
          }
          const securedResetLocation = resetLocation
          if (new URLSearchParams(securedResetLocation.hash.replace(/^#/, "")).has("token_hash")) {
            setResetLocation(null)
          }
          await completeSupabasePasswordResetFromLocation(securedResetLocation, {
            password,
            confirmPassword,
            legalAcceptance: currentLegalAcceptance("password_reset"),
          })
          setPassword("")
          setConfirmPassword("")
          setSubmitted(true)
          return
        }
        resetLocalPassword({ email, token, password, confirmPassword })
        setSubmitted(true)
        return
      }

      if (useSupabase) {
        await requestSupabasePasswordReset(email)
        setSubmitted(true)
        return
      }

      const request = requestLocalPasswordReset(email)
      setResetPath(request.resetPath)
      setSubmitted(true)
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Password reset failed.")
    }
  }

  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground" style={authLightThemeStyle}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,101,252,0.14),transparent_34%)]" />
      <div className="absolute left-1/2 top-12 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative z-10 mx-auto flex w-full max-w-md flex-col gap-5">
        <ButtonLink href="/" variant="outline" className="w-fit bg-background/80 supports-backdrop-filter:backdrop-blur-md">
          <IconArrowLeft data-icon="inline-start" />
          Return to homepage
        </ButtonLink>
        <Card className="w-full border-border bg-background/90 shadow-2xl shadow-primary/10 supports-backdrop-filter:backdrop-blur-md">
          <CardHeader>
            <div className="mb-3">
              <BrandMark />
            </div>
            <CardTitle className="text-2xl">
              {isReset ? "Set a new password" : "Reset your password"}
            </CardTitle>
            <CardDescription>
              {isReset
                ? useSupabase
                  ? "Use the reset or invitation link from your email in any current browser. Maintain Flow will ask you to sign in again when it is done."
                  : "Use a valid reset link to set a new password."
                : useSupabase
                  ? "Enter your account email and Maintain Flow will send a reset link."
                  : "Enter your account email to create a secure reset link."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
              <FieldGroup className="gap-5">
                {!isReset ? (
                  <Field data-invalid={!!error}>
                    <FieldLabel htmlFor="reset-email">Email</FieldLabel>
                    <Input
                      id="reset-email"
                      type="email"
                      autoComplete="email"
                      placeholder="operator@agency.test"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                    <FieldDescription>
                      Maintain Flow will send a password reset link if this address has an account. You can open it in any current browser or device.
                    </FieldDescription>
                    <FieldDescription className="text-destructive">{error}</FieldDescription>
                  </Field>
                ) : (
                  <>
                    {!useSupabase ? (
                      <Field>
                        <FieldLabel htmlFor="reset-email-confirm">Email</FieldLabel>
                        <Input id="reset-email-confirm" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
                      </Field>
                    ) : null}
                    <Field>
                      <FieldLabel htmlFor="new-password">New password</FieldLabel>
                      <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                    </Field>
                    <Field data-invalid={!!error}>
                      <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
                      <Input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
                      <FieldDescription className="text-destructive">{error}</FieldDescription>
                    </Field>
                  </>
                )}
                {submitted ? (
                  <Field>
                    <FieldDescription className="text-primary">
                      {isReset
                        ? "Password updated and the temporary email-link session was revoked. Sign in to continue."
                        : useSupabase
                          ? "If this address has an account, its reset email is on the way."
                          : "Reset link created:"}
                    </FieldDescription>
                    {!isReset && resetPath ? (
                      <Link className="text-sm text-primary underline-offset-4 hover:underline" href={resetPath}>
                        Open reset link
                      </Link>
                    ) : null}
                  </Field>
                ) : null}
              </FieldGroup>
              {isReset && useSupabase ? (
                <div className={`rounded-lg border p-4 ${legalError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="reset-legal-consent"
                      checked={legalAccepted}
                      aria-invalid={Boolean(legalError)}
                      aria-describedby={`reset-legal-consent-description${legalError ? " reset-legal-consent-error" : ""}`}
                      onCheckedChange={(value) => {
                        setLegalAccepted(value === true)
                        setLegalError("")
                      }}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <label className="cursor-pointer text-sm font-medium leading-6" htmlFor="reset-legal-consent">
                        I agree to the current Terms and acknowledge the Privacy Policy.
                      </label>
                      <p id="reset-legal-consent-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                        Required for invitation activation and password recovery. Read the{" "}
                        <Link className="font-medium text-primary hover:underline" href="/terms">Terms</Link> ({MAINTAINFLOW_TERMS_LAST_UPDATED}) and{" "}
                        <Link className="font-medium text-primary hover:underline" href="/privacy">Privacy Policy</Link> ({MAINTAINFLOW_PRIVACY_LAST_UPDATED}). This box is never selected for you.
                      </p>
                    </div>
                  </div>
                  {legalError ? (
                    <p id="reset-legal-consent-error" role="alert" className="mt-3 text-xs font-medium leading-5 text-destructive">
                      {legalError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-col gap-3">
                <Button type="submit" disabled={isReset && !resetLocation}>
                  {isReset ? <IconShieldLock data-icon="inline-start" /> : <IconMail data-icon="inline-start" />}
                  {isReset ? "Set password" : "Send reset link"}
                  <IconArrowRight data-icon="inline-end" />
                </Button>
                <ButtonLink href="/sign-in" variant="outline">
                  <IconArrowLeft data-icon="inline-start" />
                  Back to sign in
                </ButtonLink>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}
