"use client"

import { BrandMark } from "@/components/brand/brand-mark"
import { ButtonLink } from "@/components/ui/button-link"
import { signupHref } from "@/lib/auth/signup-intent"
import { IconMenu2, IconX } from "@tabler/icons-react"
import { useLenis } from "lenis/react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

const navItems = [
  { label: "How it works", target: "#how-it-works", href: "/#how-it-works" },
  { label: "Evidence", target: "#evidence", href: "/#evidence" },
  { label: "Pricing", target: "#pricing", href: "/#pricing" },
] as const

const startFreeHref = signupHref({ plan: "free", template: "lead_form", interval: "monthly" })

export default function Navigation() {
  const lenis = useLenis()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  function followSection(target: string) {
    setOpen(false)
    if (pathname !== "/") return
    lenis?.scrollTo(target, { duration: 1.1 })
  }

  return (
    <header className="fixed inset-x-0 top-0 z-[100] border-b border-slate-200/80 bg-white/95 text-slate-950 supports-backdrop-filter:backdrop-blur-xl">
      <nav aria-label="Public navigation" className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between gap-6 px-5 sm:px-8 lg:px-12">
        <Link href="/" aria-label="Maintain Flow home" className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">
          <BrandMark />
        </Link>

        <div className="hidden items-center gap-8 lg:flex">
          {navItems.map((item) => (
            <Link
              key={item.target}
              href={item.href}
              onClick={(event) => {
                if (pathname === "/") event.preventDefault()
                followSection(item.target)
              }}
              className="rounded-sm text-sm font-medium text-slate-600 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4"
            >
              {item.label}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-2 lg:flex">
          <ButtonLink variant="ghost" href="/sign-in" className="text-slate-700 hover:bg-slate-100 hover:text-slate-950">
            Log in
          </ButtonLink>
          <ButtonLink href={startFreeHref} data-signup-cta="nav_desktop" className="bg-blue-600 text-white hover:bg-blue-700">
            Start free
          </ButtonLink>
        </div>

        <div className="flex items-center gap-2 lg:hidden">
          <ButtonLink href={startFreeHref} data-signup-cta="nav_mobile" size="sm" className="bg-blue-600 text-white hover:bg-blue-700">
            Start free
          </ButtonLink>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="public-mobile-navigation"
            onClick={() => setOpen((current) => !current)}
            className="flex size-10 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            {open ? <IconX className="size-5" /> : <IconMenu2 className="size-5" />}
          </button>
        </div>
      </nav>

      {open ? (
        <div id="public-mobile-navigation" className="border-t border-slate-200 bg-white px-5 py-5 lg:hidden">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-1">
            {navItems.map((item) => (
              <Link
                key={item.target}
                href={item.href}
                onClick={(event) => {
                  if (pathname === "/") event.preventDefault()
                  followSection(item.target)
                }}
                className="rounded-md px-3 py-3 text-base font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                {item.label}
              </Link>
            ))}
            <ButtonLink variant="outline" href="/sign-in" className="mt-3 w-full border-slate-200 bg-white text-slate-800">
              Log in
            </ButtonLink>
          </div>
        </div>
      ) : null}
    </header>
  )
}
