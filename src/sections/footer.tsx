import { BrandMark } from "@/components/brand/brand-mark"
import { signupHref } from "@/lib/auth/signup-intent"
import Link from "next/link"

const startFreeHref = signupHref({ plan: "free", template: "lead_form", interval: "monthly" })

const links = [
  { label: "Product", href: "/#how-it-works" },
  { label: "Security", href: "/security" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
] as const

export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white text-slate-950">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-5 py-10 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-12">
        <div>
          <Link href="/" aria-label="Maintain Flow home" className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-4">
            <BrandMark />
          </Link>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
            Deterministic evidence that approved customer journeys still reach the intended business outcome.
          </p>
        </div>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-8">
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-4">
            <Link href="/sign-in" className="text-sm font-medium text-slate-700 hover:text-slate-950">Log in</Link>
            <Link href={startFreeHref} data-signup-cta="footer_company" className="text-sm font-semibold text-blue-600 hover:text-blue-700">Start free</Link>
          </div>
        </div>
      </div>
      <div className="border-t border-slate-100 px-5 py-5 text-center text-xs text-slate-500 sm:px-8">
        © {new Date().getFullYear()} Maintain Flow. Public targets only; no control bypassing or autonomous production changes.
      </div>
    </footer>
  )
}
