"use client"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { useAuth } from "@/components/auth/auth-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconBuilding,
  IconChevronDown,
  IconCreditCard,
  IconFolder,
  IconLogout,
  IconMenu2,
  IconReportAnalytics,
  IconRoute,
  IconSettings,
  IconUsers,
} from "@tabler/icons-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { type ReactNode, useState } from "react"
import { useEvals } from "./evals-provider"

const primaryNav = [
  { label: "Projects", href: "/projects", prefix: "/projects", icon: IconFolder },
  { label: "Journeys", href: "/journeys", prefix: "/journeys", icon: IconRoute },
  { label: "Incidents", href: "/incidents", prefix: "/incidents", icon: IconAlertTriangle },
  { label: "Reports", href: "/reports", prefix: "/reports", icon: IconReportAnalytics },
] as const

export function EvalsAppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { projects, activeProjectId, setActiveProjectId, pagination, previewMode } = useEvals()
  const { user, signOut } = useAuth()
  const preview = previewMode
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0]

  if (pathname.startsWith("/share/reports/")) {
    return <div className="min-h-dvh bg-[#fbfaf7] text-slate-950">{children}</div>
  }

  return (
    <div className="min-h-dvh bg-[#fbfaf7] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-[#fbfaf7]/95 backdrop-blur">
        <div className="mx-auto flex h-[58px] max-w-[1487px] items-center gap-3 px-5 md:px-6">
          <Link href="/projects" aria-label="Maintain Flow projects" className="mr-auto inline-flex shrink-0 items-center gap-2 text-slate-950 lg:mr-0">
            <IconActivityHeartbeat aria-hidden className="size-7 stroke-[2.25] text-blue-600" />
            <span className="text-lg font-semibold tracking-[-0.025em]">Maintain Flow</span>
          </Link>

          <nav aria-label="Primary" className="mx-auto hidden h-full items-center gap-1 lg:flex">
            {primaryNav.map((item) => {
              const active = pathname.startsWith(item.prefix) || (pathname === "/evals-preview" && item.prefix === "/journeys")
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-full items-center gap-2 px-4 text-sm font-medium text-slate-700 transition-colors hover:text-slate-950",
                    active && "text-blue-600 after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-blue-600",
                  )}
                >
                  <Icon aria-hidden className="size-[18px]" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          <div className="hidden items-center gap-3 lg:flex">
            <ProjectSwitcher
              projects={projects}
              activeProjectId={activeProject?.id ?? ""}
              onSelect={setActiveProjectId}
              pagination={pagination.projects}
            />
            <AccountMenu name={preview ? "Lena Moore" : user?.name || user?.email || "Workspace member"} role={preview ? "Owner" : user?.role || "Member"} onSignOut={signOut} />
          </div>

          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger
              id="evals-mobile-navigation-trigger"
              render={<Button variant="outline" size="icon-sm" className="rounded-md border-slate-200 bg-white lg:hidden" aria-label="Open product navigation" />}
            >
              <IconMenu2 aria-hidden />
            </SheetTrigger>
            <SheetContent side="right" className="w-[19rem] bg-[#fbfaf7] p-0">
              <SheetHeader className="border-b border-slate-200 p-5 text-left">
                <SheetTitle className="flex items-center gap-2">
                  <IconActivityHeartbeat className="size-6 text-blue-600" />
                  Maintain Flow
                </SheetTitle>
                <SheetDescription>Business evals for critical customer journeys.</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-5 p-4">
                <ProjectSwitcher projects={projects} activeProjectId={activeProject?.id ?? ""} onSelect={setActiveProjectId} pagination={pagination.projects} mobile />
                <nav aria-label="Mobile product navigation" className="flex flex-col gap-1">
                  {primaryNav.map((item) => {
                    const active = pathname.startsWith(item.prefix) || (pathname === "/evals-preview" && item.prefix === "/journeys")
                    const Icon = item.icon
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-700",
                          active ? "bg-blue-50 text-blue-700" : "hover:bg-slate-100",
                        )}
                      >
                        <Icon aria-hidden className="size-[18px]" />
                        {item.label}
                      </Link>
                    )
                  })}
                </nav>
                <div className="border-t border-slate-200 pt-4">
                  <Link href="/settings/workspace" onClick={() => setMobileOpen(false)} className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
                    <IconSettings className="size-[18px]" /> Settings
                  </Link>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      {children}
    </div>
  )
}

function ProjectSwitcher({
  projects,
  activeProjectId,
  onSelect,
  pagination,
  mobile = false,
}: {
  projects: ReturnType<typeof useEvals>["projects"]
  activeProjectId: string
  onSelect: (id: string) => void
  pagination: ReturnType<typeof useEvals>["pagination"]["projects"]
  mobile?: boolean
}) {
  const active = projects.find((project) => project.id === activeProjectId) ?? projects[0]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={mobile ? "evals-project-switcher-mobile-trigger" : "evals-project-switcher-desktop-trigger"}
        render={<Button variant="outline" className={cn("justify-between rounded-md border-slate-200 bg-white px-3 text-slate-800 shadow-none", mobile ? "w-full" : "w-[204px]")} />}
      >
        <span className="flex min-w-0 items-center gap-2">
          <IconBuilding aria-hidden className="size-4 shrink-0 text-slate-500" />
          <span className="truncate">{active?.name ?? "Choose project"}</span>
        </span>
        <IconChevronDown aria-hidden className="size-4 text-slate-500" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[240px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Active project</DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem key={project.id} onClick={() => onSelect(project.id)} className={cn(project.id === activeProjectId && "bg-blue-50 text-blue-700")}>
              <IconBuilding />
              <span className="min-w-0">
                <span className="block truncate">{project.name}</span>
                <span className="block truncate text-xs text-slate-500">{project.domain}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {pagination.hasMore ? (
            <DropdownMenuItem disabled={pagination.loadingMore} onClick={() => void pagination.loadMore()}>
              <IconChevronDown /> {pagination.loadingMore ? "Loading projects…" : "Load more projects"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/projects" />}>
          <IconFolder /> View all projects
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu({ name, role, onSignOut }: { name: string; role: string; onSignOut: () => Promise<void> }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "MF"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger id="evals-account-menu-trigger" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2" aria-label="Open account menu">
        <Avatar className="size-9 border border-slate-200 bg-slate-100">
          <AvatarFallback className="text-xs font-medium text-slate-700">{initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block text-sm text-slate-900">{name}</span>
            <span className="block text-xs font-normal text-slate-500">{role}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href="/settings/workspace" />}><IconSettings /> Workspace settings</DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/settings/team" />}><IconUsers /> Team</DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/settings/billing" />}><IconCreditCard /> Billing</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void onSignOut()}><IconLogout /> Sign out</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
