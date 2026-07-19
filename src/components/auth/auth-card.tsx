"use client"

import { BrandMark } from "@/components/brand/brand-mark"
import { authLightThemeStyle } from "@/components/auth/auth-light-theme"
import { Button } from "@/components/ui/button"
import { ButtonLink } from "@/components/ui/button-link"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { isSignupConfirmationRequired, toActionableAuthError } from "@/lib/auth/errors"
import { safeAuthNextPath } from "@/lib/auth/next-path"
import { onboardingPathForIntent, readPublicSignupIntent, type PublicSignupIntent } from "@/lib/auth/signup-intent"
import {
  AUTH_PASSWORD_MIN_LENGTH,
  firstInvalidSignupField,
  type SignupField,
  type SignupFieldErrors,
  validateSignupInput,
} from "@/lib/auth/signup-validation"
import { useAuth } from "@/components/auth/auth-provider"
import {
  IconActivity,
  IconArrowLeft,
  IconArrowRight,
  IconBrandGoogle,
  IconCircleCheck,
  IconKey,
  IconReportAnalytics,
  IconShieldCheck,
  IconUserPlus,
} from "@tabler/icons-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FormEvent, useEffect, useRef, useState } from "react"

type AuthMode = "login" | "signup"

type AuthCardProps = {
  mode: AuthMode
}

const roleOptions = [
  "Founder / owner",
  "Product or engineering",
  "Operations or delivery",
  "Client success",
  "Independent builder",
]

export function AuthCard({ mode }: AuthCardProps) {
  const router = useRouter()
  const { ready, user, authMode, signIn, signInWithGoogle, signUp } = useAuth()
  const [name, setName] = useState("")
  const [company, setCompany] = useState("")
  const [role, setRole] = useState(roleOptions[0])
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({})
  const [formError, setFormError] = useState("")
  const [notice, setNotice] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [nextPath, setNextPath] = useState(mode === "signup" ? "/onboarding" : "/projects")
  const [signupIntent, setSignupIntent] = useState<PublicSignupIntent>({ plan: null, template: null, interval: null })
  const [intentReady, setIntentReady] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const companyRef = useRef<HTMLInputElement>(null)
  const roleRef = useRef<HTMLSelectElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const next = params.get("next")
    const fallback = mode === "signup" ? onboardingPathForIntent(params) : "/projects"

    setSignupIntent(readPublicSignupIntent(params))
    setNextPath(safeAuthNextPath(next, fallback))

    const authError = params.get("authError")
    if (authError) {
      setFormError(toActionableAuthError(authError, "Authentication could not be completed."))
    }
    setIntentReady(true)
  }, [mode])

  useEffect(() => {
    if (intentReady && ready && user) {
      router.replace(nextPath)
    }
  }, [intentReady, nextPath, ready, router, user])

  const isSignup = mode === "signup"

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFieldErrors({})
    setFormError("")
    setNotice("")

    let signupInput = { name, email, password, company, role }
    if (isSignup) {
      const validation = validateSignupInput(signupInput)
      if (!validation.ok) {
        setFieldErrors(validation.errors)
        focusSignupField(firstInvalidSignupField(validation.errors))
        return
      }
      signupInput = validation.value
    }

    setIsSubmitting(true)

    try {
      if (isSignup) {
        await signUp({ ...signupInput, nextPath })
      } else {
        await signIn({ email, password })
      }

      router.replace(nextPath)
    } catch (authError) {
      if (isSignup && isSignupConfirmationRequired(authError)) {
        setNotice(authError.message)
        return
      }

      const message = authError instanceof Error ? authError.message : ""
      setFormError(toActionableAuthError(message, "Authentication failed."))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleGoogleSignIn() {
    setFieldErrors({})
    setFormError("")
    setNotice("")
    try {
      await signInWithGoogle({ nextPath })
    } catch (googleError) {
      const message = googleError instanceof Error ? googleError.message : ""
      setFormError(toActionableAuthError(message, "Google sign-in is not configured."))
    }
  }

  function clearSignupFieldError(field: SignupField) {
    setFieldErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
    setFormError("")
  }

  function focusSignupField(field: SignupField | null) {
    const fieldRefs = {
      name: nameRef,
      company: companyRef,
      role: roleRef,
      email: emailRef,
      password: passwordRef,
    }
    fieldRefs[field ?? "name"].current?.focus()
  }

  return (
    <section className="relative min-h-screen overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8" style={authLightThemeStyle}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(0,101,252,0.14),transparent_34%)]" />
      <div className="absolute left-1/2 top-0 h-80 w-[52rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl flex-col justify-center">
        <div className="mb-5 flex">
          <ButtonLink href="/" variant="outline" className="bg-background/80 supports-backdrop-filter:backdrop-blur-md">
            <IconArrowLeft data-icon="inline-start" />
            Return to homepage
          </ButtonLink>
        </div>
        <div className="grid w-full gap-5 lg:grid-cols-[1fr_0.86fr]">
          <aside className="hidden min-h-[36rem] flex-col justify-between rounded-xl border border-border bg-muted/30 p-8 shadow-2xl shadow-primary/5 supports-backdrop-filter:backdrop-blur-md lg:flex">
            <BrandMark />

            <div className="max-w-xl">
              <h1 className="text-4xl font-medium tracking-tight text-balance xl:text-5xl">
                {isSignup ? "Create your workspace and prove one critical journey." : "Return to your Business Evals workspace."}
              </h1>
              <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground">
                Maintain Flow continuously verifies approved customer journeys, turns failures into Incidents and keeps deterministic recovery evidence ready to share.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <AuthProofItem icon={IconShieldCheck} label="Projects" detail="Authorized boundaries" />
              <AuthProofItem icon={IconActivity} label="Journeys" detail="Deterministic stages" />
              <AuthProofItem icon={IconReportAnalytics} label="Reports" detail="Verified recovery" />
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/10 p-4 text-sm text-muted-foreground">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <IconCircleCheck aria-hidden className="size-4" />
              </span>
              <span>
                {isSignup
                  ? signupIntent.plan && signupIntent.plan !== "free"
                    ? "Your plan and template choice stay attached to onboarding. Checkout opens only after you review and confirm it in Billing."
                    : "No sales call, approval, or scheduled onboarding. Start with one browser-only Lead form journey on Free."
                  : "Use email/password or Google to continue."}
              </span>
            </div>
          </aside>

          <Card className="mx-auto w-full max-w-lg border-border bg-background/90 py-0 text-card-foreground shadow-2xl shadow-primary/10 supports-backdrop-filter:backdrop-blur-md">
            <CardHeader className="gap-4 px-6 pt-6 sm:px-8 sm:pt-8">
              <div className="lg:hidden">
                <BrandMark />
              </div>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <CardTitle className="text-3xl font-medium tracking-tight text-balance">
                    {isSignup ? "Create your Maintain Flow account" : "Log in to Maintain Flow"}
                  </CardTitle>
                  <CardDescription className="mt-3 text-base leading-7">
                    {isSignup
                      ? authMode === "supabase"
                        ? "Use an inbox you can access for Maintain Flow confirmation and recovery emails."
                        : "Use an inbox you can access. Test/example domains are rejected so confirmation and recovery stay reliable."
                      : authMode === "supabase"
                        ? "Log in with your Maintain Flow email and password."
                        : "Log in with your Maintain Flow email and password."}
                  </CardDescription>
                </div>
                <span className="hidden shrink-0 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary sm:inline-flex">
                  {authMode === "supabase" ? "Email + SSO" : "Email login"}
                </span>
              </div>
            </CardHeader>

            <CardContent className="px-6 pb-6 sm:px-8 sm:pb-8">
              {isSignup && intentReady && signupIntent.plan ? (
                <SignupIntentSummary intent={signupIntent} />
              ) : null}
              {notice ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-5 rounded-lg border border-primary/20 bg-primary/10 p-4 text-sm leading-6 text-foreground"
                >
                  {notice}
                </div>
              ) : null}
              <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
                {formError ? (
                  <div
                    role="alert"
                    aria-live="assertive"
                    className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm leading-6 text-destructive"
                  >
                    {formError}
                  </div>
                ) : null}
                <FieldGroup className="gap-5">
                  {isSignup && (
                    <>
                      <Field data-invalid={Boolean(fieldErrors.name)}>
                        <FieldLabel htmlFor="name">Name</FieldLabel>
                        <Input
                          ref={nameRef}
                          id="name"
                          className="h-11 border-border bg-background text-foreground placeholder:text-muted-foreground/70"
                          autoComplete="name"
                          aria-invalid={Boolean(fieldErrors.name)}
                          aria-describedby={fieldErrors.name ? "signup-name-error" : undefined}
                          value={name}
                          onChange={(event) => {
                            setName(event.target.value)
                            clearSignupFieldError("name")
                          }}
                          placeholder="Alex Morgan"
                        />
                        <FieldError id="signup-name-error">{fieldErrors.name}</FieldError>
                      </Field>
                      <Field data-invalid={Boolean(fieldErrors.company)}>
                        <FieldLabel htmlFor="company">Company or team</FieldLabel>
                        <Input
                          ref={companyRef}
                          id="company"
                          className="h-11 border-border bg-background text-foreground placeholder:text-muted-foreground/70"
                          autoComplete="organization"
                          aria-invalid={Boolean(fieldErrors.company)}
                          aria-describedby={fieldErrors.company ? "signup-company-error" : undefined}
                          value={company}
                          onChange={(event) => {
                            setCompany(event.target.value)
                            clearSignupFieldError("company")
                          }}
                          placeholder="Acme product or agency"
                        />
                        <FieldError id="signup-company-error">{fieldErrors.company}</FieldError>
                      </Field>
                      <Field data-invalid={Boolean(fieldErrors.role)}>
                        <FieldLabel htmlFor="role">Role</FieldLabel>
                        <NativeSelect
                          ref={roleRef}
                          id="role"
                          className="h-11 w-full border-border bg-background text-foreground"
                          aria-invalid={Boolean(fieldErrors.role)}
                          aria-describedby={fieldErrors.role ? "signup-role-error" : undefined}
                          value={role}
                          onChange={(event) => {
                            setRole(event.target.value)
                            clearSignupFieldError("role")
                          }}
                        >
                          {roleOptions.map((option) => (
                            <NativeSelectOption key={option} value={option}>
                              {option}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                        <FieldError id="signup-role-error">{fieldErrors.role}</FieldError>
                      </Field>
                    </>
                  )}

                  <Field data-invalid={Boolean(fieldErrors.email)}>
                    <FieldLabel htmlFor="email">Email</FieldLabel>
                    <Input
                      ref={emailRef}
                      id="email"
                      className="h-11 border-border bg-background text-foreground placeholder:text-muted-foreground/70"
                      type="email"
                      autoComplete="email"
                      aria-invalid={Boolean(fieldErrors.email)}
                      aria-describedby={
                        isSignup
                          ? `signup-email-description${fieldErrors.email ? " signup-email-error" : ""}`
                          : undefined
                      }
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        clearSignupFieldError("email")
                      }}
                      placeholder="you@company.com"
                    />
                    {isSignup && (
                      <FieldDescription id="signup-email-description">
                        Use an inbox you can access for confirmation and password recovery. Test, example, and localhost domains are rejected.
                      </FieldDescription>
                    )}
                    <FieldError id="signup-email-error">{fieldErrors.email}</FieldError>
                  </Field>

                  <Field data-invalid={Boolean(fieldErrors.password)}>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input
                      ref={passwordRef}
                      id="password"
                      className="h-11 border-border bg-background text-foreground placeholder:text-muted-foreground/70"
                      type="password"
                      autoComplete={isSignup ? "new-password" : "current-password"}
                      aria-invalid={Boolean(fieldErrors.password)}
                      aria-describedby={
                        isSignup
                          ? `signup-password-description${fieldErrors.password ? " signup-password-error" : ""}`
                          : undefined
                      }
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        clearSignupFieldError("password")
                      }}
                      placeholder={isSignup ? `Use ${AUTH_PASSWORD_MIN_LENGTH} or more characters` : "Enter your password"}
                    />
                    {isSignup && (
                      <FieldDescription id="signup-password-description">
                        Use {AUTH_PASSWORD_MIN_LENGTH} or more characters.
                      </FieldDescription>
                    )}
                    <FieldError id="signup-password-error">{fieldErrors.password}</FieldError>
                  </Field>
                </FieldGroup>

                <div className="flex flex-col gap-3">
                  {authMode === "supabase" ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full border-border bg-background text-foreground hover:bg-muted/70"
                        disabled={isSubmitting}
                        onClick={handleGoogleSignIn}
                      >
                        <IconBrandGoogle data-icon="inline-start" />
                        Continue with Google
                      </Button>
                      <p className="text-sm leading-6 text-muted-foreground">
                        Google creates or opens your Maintain Flow account and returns you to self-serve onboarding.
                      </p>
                    </>
                  ) : null}
                  <Button type="submit" className="h-11 w-full" disabled={!ready || isSubmitting}>
                    {isSignup ? <IconUserPlus data-icon="inline-start" /> : <IconKey data-icon="inline-start" />}
                    {isSubmitting ? "Working..." : isSignup ? "Create account" : "Log in"}
                    <IconArrowRight data-icon="inline-end" />
                  </Button>
                  {isSignup ? (
                    <p className="text-center text-xs leading-5 text-muted-foreground">
                      By creating an account, you agree to the <Link className="font-medium text-primary hover:underline" href="/terms">Terms</Link> and acknowledge the <Link className="font-medium text-primary hover:underline" href="/privacy">Privacy Policy</Link>.
                    </p>
                  ) : null}
                </div>

                {!isSignup && (
                  <Link className="text-center text-sm font-medium text-primary hover:underline" href="/forgot-password">
                    Forgot password?
                  </Link>
                )}

                <p className="text-center text-sm text-muted-foreground">
                  {isSignup ? (
                    <>
                      Already have an account?{" "}
                      <Link className="font-medium text-primary hover:underline" href="/sign-in">
                        Log in
                      </Link>
                    </>
                  ) : (
                    <>
                      New to Maintain Flow?{" "}
                      <Link className="font-medium text-primary hover:underline" href="/sign-up">
                        Start free
                      </Link>
                    </>
                  )}
                </p>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

function SignupIntentSummary({ intent }: { intent: PublicSignupIntent }) {
  const plan = intent.plan === "solo" ? "Solo" : intent.plan === "team" ? "Team" : intent.plan === "agency" ? "Agency" : "Free"
  const template = intent.template === "trial_signup" ? "Trial signup" : "Lead form"
  const paid = intent.plan !== null && intent.plan !== "free"
  const interval = paid && intent.interval === "annual" ? " annual" : paid ? " monthly" : ""

  return (
    <div className="mb-5 rounded-lg border border-primary/20 bg-primary/10 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <IconCircleCheck aria-hidden className="size-4 text-primary" />
        {plan}{interval} · {template} selected
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {paid
          ? "Create your account now. This choice is preserved for review in Billing; checkout never opens and you are never charged automatically."
          : "Create your account to start one browser-only Lead form journey. No card required."}
      </p>
    </div>
  )
}

function AuthProofItem({
  icon: Icon,
  label,
  detail,
}: {
  icon: typeof IconShieldCheck
  label: string
  detail: string
}) {
  return (
    <div className="rounded-lg border border-border bg-background/80 p-4">
      <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Icon aria-hidden className="size-4" />
      </span>
      <p className="mt-4 text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  )
}
