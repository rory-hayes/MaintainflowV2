"use client"

import * as Sentry from "@sentry/nextjs"
import Link from "next/link"
import { useEffect } from "react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body className="bg-white font-sans text-slate-950 antialiased">
        <main className="flex min-h-screen items-center justify-center px-5 py-16">
          <section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-blue-600">Maintain Flow</p>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Something went wrong.</h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              We could not confirm whether the last action completed. Check its current status before repeating it, then retry this screen or return home.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-11 items-center justify-center rounded-full bg-blue-600 px-6 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Try again
              </button>
              <Link
                href="/"
                className="inline-flex h-11 items-center justify-center rounded-full border border-slate-300 bg-white px-6 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Return home
              </Link>
            </div>
          </section>
        </main>
      </body>
    </html>
  )
}
