"use client"

import { useAuth } from "@/components/auth/auth-provider"
import { useCoreLoopContext } from "@/components/app/core-loop-provider"
import { FirstRunSetupTour } from "@/components/app/first-run-setup-tour"
import { BrandMark } from "@/components/brand/brand-mark"
import { Button } from "@/components/ui/button"
import { ButtonLink } from "@/components/ui/button-link"
import { Spinner } from "@/components/ui/spinner"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { appNavItems, getScreenKeyFromPath, getScreenSummary } from "@/data/maintainflow"
import { isActivationChecklistComplete } from "@/lib/core/local-store"
import { resolveWorkspaceReadiness } from "@/lib/core/workspace-readiness"
import { cn } from "@/lib/utils"
import {
  IconAlertTriangle,
  IconArrowRight,
  IconClipboardCheck,
  IconLogout,
  IconMenu2,
  IconPlus,
  IconReportAnalytics,
  IconSettings,
  IconSparkles,
} from "@tabler/icons-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react"

export function MaintainFlowAppShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { ready, user, signOut, updateProfile } = useAuth()
  const core = useCoreLoopContext()
  const [profileOpen, setProfileOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [setupTourOpen, setSetupTourOpen] = useState(false)
  const [setupTourChecked, setSetupTourChecked] = useState(false)

  const screenKey = useMemo(() => getScreenKeyFromPath(pathname ?? "/dashboard"), [pathname])
  const screen = getScreenSummary(screenKey)
  const readiness = resolveWorkspaceReadiness({
    authReady: ready,
    hasUser: !!user,
    coreLoading: core.loading,
    creatingAgency: core.creatingAgency,
    hasAgency: !!core.agency,
    pathname,
  })
  const showClientAction = readiness.appActionsEnabled && screenKey !== "clients"
  const showWorkflowAction = readiness.appActionsEnabled && screenKey !== "workflows"
  const activationComplete = isActivationChecklistComplete(core.checklist)
  const showSetupGuide = !activationComplete || screenKey === "onboarding"
  const showActionCenterAction = readiness.appActionsEnabled && activationComplete && screenKey !== "action-center"
  const showReportsAction = readiness.appActionsEnabled && activationComplete && screenKey !== "reports" && screenKey !== "report-detail"
  const setupTourStorageKey = user && core.agency
    ? `maintainflow:first-run-setup-tour:v1:${user.id}:${core.agency.id}`
    : null

  useEffect(() => {
    if (ready && !user) {
      const nextPath = pathname && pathname !== "/" ? pathname : "/dashboard"
      router.replace(`/sign-in?next=${encodeURIComponent(nextPath)}`)
    }
  }, [pathname, ready, router, user])

  useEffect(() => {
    if (!readiness.shouldRedirectToOnboarding) {
      return
    }

    router.replace("/onboarding")
  }, [readiness.shouldRedirectToOnboarding, router])

  useEffect(() => {
    setSetupTourChecked(false)
  }, [setupTourStorageKey])

  useEffect(() => {
    if (setupTourChecked || screenKey !== "overview" || !readiness.workspaceReady || !setupTourStorageKey) {
      return
    }

    setSetupTourChecked(true)
    try {
      if (window.localStorage.getItem(setupTourStorageKey) !== "complete") {
        setSetupTourOpen(true)
      }
    } catch {
      setSetupTourOpen(true)
    }
  }, [readiness.workspaceReady, screenKey, setupTourChecked, setupTourStorageKey])

  async function handleSignOut() {
    await signOut()
    router.replace("/sign-in")
  }

  function updateProfileForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    updateProfile({
      name: String(formData.get("name") ?? ""),
      company: String(formData.get("company") ?? ""),
      role: String(formData.get("role") ?? ""),
    })
    setProfileOpen(false)
  }

  function completeSetupTour() {
    if (!setupTourStorageKey) return

    try {
      window.localStorage.setItem(setupTourStorageKey, "complete")
    } catch {
      // localStorage can be unavailable in strict privacy modes; closing the modal should still work.
    }
  }

  function updateSetupTourOpen(nextOpen: boolean) {
    if (!nextOpen) {
      completeSetupTour()
    }
    setSetupTourOpen(nextOpen)
  }

  function openWorkflowSetupFromTour() {
    completeSetupTour()
    setSetupTourOpen(false)
    router.push("/workflows?add=workflow")
  }

  function renderNavItems({ mobile = false }: { mobile?: boolean } = {}) {
    return appNavItems.map((item) => {
      const Icon = item.icon
      const active = isNavItemActive(item.key, screenKey)
      const className = cn(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
        mobile ? "w-full" : "lg:w-full",
        active ? "bg-background/70 text-foreground shadow-xs" : "text-muted-foreground hover:bg-background/55 hover:text-foreground"
      )

      if (!readiness.appActionsEnabled) {
        return (
          <span
            key={item.href}
            aria-disabled="true"
            className={cn(
              className,
              "cursor-not-allowed text-muted-foreground/55 hover:bg-transparent hover:text-muted-foreground/55"
            )}
          >
            <Icon aria-hidden className="shrink-0" />
            {item.label}
          </span>
        )
      }

      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={mobile ? () => setMobileNavOpen(false) : undefined}
          className={className}
        >
          <Icon aria-hidden className="shrink-0" />
          {item.label}
        </Link>
      )
    })
  }

  if (!ready || readiness.workspacePending || readiness.shouldRedirectToOnboarding) {
    return <AppShellLoadingState />
  }

  if (!user) {
    const nextPath = pathname && pathname !== "/" ? pathname : "/dashboard"
    const signInHref = `/sign-in?next=${encodeURIComponent(nextPath)}`

    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
        <Card className="w-full max-w-md border-border bg-background/90 shadow-xl">
          <CardHeader>
            <BrandMark />
            <CardTitle>Sign in to open this workspace</CardTitle>
            <CardDescription>
              Maintain Flow app routes are private. Sign in to continue to the dashboard, workflows, issues, or reports.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ButtonLink href={signInHref}>
              Sign in to continue
              <IconArrowRight data-icon="inline-end" />
            </ButtonLink>
            <noscript>
              <p className="text-sm leading-6 text-muted-foreground">
                JavaScript is required for the Maintain Flow app shell. Use the sign-in link above to continue.
              </p>
            </noscript>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <div className="min-h-screen bg-background lg:pl-72">
      <aside className="border-b border-border bg-sidebar/90 supports-backdrop-filter:backdrop-blur-md lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:w-72 lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4 lg:flex-col lg:items-start lg:gap-8 lg:px-5 lg:py-6">
          <Link href="/dashboard" aria-label="Maintain Flow overview">
            <BrandMark />
          </Link>
          <div className="flex items-center gap-2 lg:w-full">
            <Button variant="outline" size="icon-sm" className="lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open app navigation">
              <IconMenu2 aria-hidden />
            </Button>
            {showSetupGuide ? (
              <ButtonLink href="/onboarding" variant="outline" size="sm" className="hidden lg:inline-flex">
                <IconSparkles data-icon="inline-start" />
                Setup guide
              </ButtonLink>
            ) : null}
          </div>
        </div>

        <nav className="mx-3 mb-4 hidden flex-col gap-1 rounded-lg bg-muted/20 p-1 lg:flex">
          {renderNavItems()}
        </nav>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-[20rem] max-w-[calc(100vw-2rem)] bg-sidebar p-0 text-sidebar-foreground">
            <SheetHeader className="border-b border-border p-4">
              <SheetTitle>Maintain Flow</SheetTitle>
              <SheetDescription>Navigate the workflow maintenance app.</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 p-4">
              {showSetupGuide ? (
                <ButtonLink href="/onboarding" variant="outline" size="sm" onClick={() => setMobileNavOpen(false)}>
                  <IconSparkles data-icon="inline-start" />
                  Setup guide
                </ButtonLink>
              ) : null}
              <nav className="flex flex-col gap-1 rounded-lg bg-muted/20 p-1">
                {renderNavItems({ mobile: true })}
              </nav>
            </div>
          </SheetContent>
        </Sheet>

        <div className="hidden px-4 pb-4 lg:mt-auto lg:block">
          <Card size="sm" className="border-border bg-background/55">
            <CardHeader>
              <CardTitle>{user.name}</CardTitle>
              <CardDescription>{user.company}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button variant="outline" size="sm" onClick={() => setProfileOpen(true)}>
                <IconSettings data-icon="inline-start" />
                Profile
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <IconLogout data-icon="inline-start" />
                Log out
              </Button>
            </CardContent>
          </Card>
        </div>
      </aside>

      <section className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 supports-backdrop-filter:backdrop-blur-md">
          <div className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-6">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">{screen.eyebrow}</p>
              <h1 className="text-2xl font-medium tracking-tight md:text-3xl">
                {screen.title}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {readiness.appActionsEnabled && screenKey === "overview" ? (
                <Button variant="outline" size="sm" onClick={() => setSetupTourOpen(true)}>
                  <IconClipboardCheck data-icon="inline-start" />
                  User setup
                </Button>
              ) : null}
              <ThemeToggle />
              {readiness.appActionsEnabled ? (
                activationComplete ? (
                  <>
                    {showActionCenterAction ? (
                      <ButtonLink href="/action-center" variant="outline" size="sm" className="hidden sm:inline-flex">
                        <IconAlertTriangle data-icon="inline-start" />
                        Action center
                      </ButtonLink>
                    ) : null}
                    {showReportsAction ? (
                      <ButtonLink href="/reports" size="sm">
                        <IconReportAnalytics data-icon="inline-start" />
                        Reports
                      </ButtonLink>
                    ) : null}
                  </>
                ) : (
                  <>
                    {showClientAction ? (
                      <ButtonLink href="/clients?add=client" variant="outline" size="sm" className="hidden sm:inline-flex">
                        <IconPlus data-icon="inline-start" />
                        Add client
                      </ButtonLink>
                    ) : null}
                    {showWorkflowAction ? (
                      <ButtonLink href="/workflows?add=workflow" size="sm">
                        <IconPlus data-icon="inline-start" />
                        Add workflow
                      </ButtonLink>
                    ) : null}
                  </>
                )
              ) : (
                <ButtonLink href="/onboarding" size="sm">
                  <IconSparkles data-icon="inline-start" />
                  Continue setup
                </ButtonLink>
              )}
            </div>
          </div>
        </header>

        <div className="px-4 py-5 lg:px-6 lg:py-6">{children}</div>
      </section>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Profile</DialogTitle>
            <DialogDescription>
              Update the profile shown across this Maintain Flow workspace.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-5" onSubmit={updateProfileForm}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="profile-name">Name</FieldLabel>
                <Input id="profile-name" name="name" defaultValue={user.name} />
              </Field>
              <Field>
                <FieldLabel htmlFor="profile-company">Agency</FieldLabel>
                <Input id="profile-company" name="company" defaultValue={user.company} />
              </Field>
              <Field>
                <FieldLabel htmlFor="profile-role">Role</FieldLabel>
                <Input id="profile-role" name="role" defaultValue={user.role} />
              </Field>
            </FieldGroup>
            <Separator />
            <DialogFooter>
              <Button type="submit">Save profile</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <FirstRunSetupTour
        open={setupTourOpen}
        onOpenChange={updateSetupTourOpen}
        onOpenWorkflowSetup={openWorkflowSetupFromTour}
      />
    </div>
  )
}

function AppShellLoadingState() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="flex flex-col items-center gap-4">
        <div className="flex size-12 items-center justify-center rounded-full border border-border bg-background/90 shadow-sm">
          <Spinner className="size-5 text-primary" />
          <span className="sr-only">Loading workspace</span>
        </div>
        <noscript>
          <Card className="w-full max-w-md border-border bg-background/90 shadow-xl">
            <CardHeader>
              <BrandMark />
              <CardTitle>Sign in to open this workspace</CardTitle>
              <CardDescription>
                Maintain Flow app routes are private. Sign in to continue to the dashboard, workflows, issues, or reports.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ButtonLink href="/sign-in?next=%2Fdashboard">
                Sign in to continue
                <IconArrowRight data-icon="inline-end" />
              </ButtonLink>
            </CardContent>
          </Card>
        </noscript>
      </div>
    </main>
  )
}

function isNavItemActive(itemKey: (typeof appNavItems)[number]["key"], screenKey: ReturnType<typeof getScreenKeyFromPath>) {
  return (
    screenKey === itemKey ||
    (itemKey === "clients" && screenKey === "client-detail") ||
    (itemKey === "workflows" && screenKey === "workflow-detail") ||
    (itemKey === "issues" && screenKey === "issue-detail") ||
    (itemKey === "reports" && screenKey === "report-detail")
  )
}
