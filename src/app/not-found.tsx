import Link from "next/link"

export default function NotFoundPage() {
  return (
    <section className="border-b border-slate-200 bg-white px-5 py-24 sm:px-8 sm:py-32">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-blue-600">404</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-6xl">
          Page not found.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
          This address does not point to a Maintain Flow page. Return to the product overview or sign in to your Business Evals workspace.
        </p>
        <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/" className="inline-flex h-11 items-center justify-center rounded-md bg-blue-600 px-6 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            Return home
          </Link>
          <Link href="/login" className="inline-flex h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-6 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            Log in
          </Link>
        </div>
      </div>
    </section>
  )
}
