"use client"

import { useState, type FormEvent } from "react"

import type { ControlledFixtureScenario } from "@/lib/evals/controlled-fixtures"

export function ControlledFixturePage({ scenario }: { scenario: ControlledFixtureScenario }) {
  const trial = scenario === "healthy-trial" || scenario === "cleanup-failure" || scenario === "malicious-link"
  const captcha = scenario === "captcha-blocked"
  const [state, setState] = useState<"idle" | "submitting" | "passed" | "failed">("idle")
  const [message, setMessage] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState("submitting")
    setMessage("")
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch("/api/business-evals-fixtures/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario,
          name: String(form.get("name") ?? ""),
          email: String(form.get("email") ?? ""),
          marker: String(form.get("marker") ?? ""),
          message: String(form.get("message") ?? ""),
          workspace: String(form.get("workspace") ?? ""),
        }),
      })
      const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { message?: string }; error?: { message?: string } } | null
      if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "The controlled fixture rejected the submission.")
      setState("passed")
      setMessage(payload.data?.message || (trial ? "Verification email queued" : "Lead received"))
    } catch (error) {
      setState("failed")
      setMessage(error instanceof Error ? error.message : "The controlled fixture rejected the submission.")
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl items-center px-5 py-12">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-blue-600">Maintain Flow controlled fixture</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{trial ? "Create a fixture workspace" : "Contact the fixture team"}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Scenario: {scenario}. Only clearly marked synthetic eval identities are accepted.</p>
        {captcha ? <div className="captcha-challenge mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-sitekey="controlled-fixture">Verify you are human. This controlled page intentionally blocks automation.</div> : null}
        <form onSubmit={submit} className="mt-6 grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium text-slate-800">Full name<input name="name" required autoComplete="off" className="h-10 rounded-md border border-slate-300 px-3 font-normal" /></label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-800">Work email<input name="email" type="email" required autoComplete="off" className="h-10 rounded-md border border-slate-300 px-3 font-normal" /></label>
          <label className="grid gap-1.5 text-sm font-medium text-slate-800">Eval marker<input name="marker" required autoComplete="off" className="h-10 rounded-md border border-slate-300 px-3 font-normal" /></label>
          {trial ? <label className="grid gap-1.5 text-sm font-medium text-slate-800">Workspace name<input name="workspace" required autoComplete="off" className="h-10 rounded-md border border-slate-300 px-3 font-normal" /></label> : <label className="grid gap-1.5 text-sm font-medium text-slate-800">Message<textarea name="message" required rows={4} className="rounded-md border border-slate-300 px-3 py-2 font-normal" /></label>}
          <button type="submit" disabled={captcha || state === "submitting"} className="h-10 rounded-md bg-blue-600 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{state === "submitting" ? "Submitting…" : trial ? "Start fixture trial" : "Send fixture lead"}</button>
        </form>
        {message ? <div role={state === "failed" ? "alert" : "status"} className={`mt-5 rounded-md p-4 text-sm ${state === "failed" ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{message}</div> : null}
      </section>
    </main>
  )
}

export function ControlledFixtureVerification({ scenario }: { scenario: "healthy-trial" | "cleanup-failure" | "malicious-link" }) {
  const [cleanup, setCleanup] = useState<"ready" | "passed" | "failed">("ready")
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl items-center px-5 py-12">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-emerald-700">Fixture account verified</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">Workspace ready</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">The synthetic fixture account reached its expected verified state.</p>
        <button type="button" onClick={() => setCleanup(scenario === "cleanup-failure" ? "failed" : "passed")} disabled={cleanup !== "ready"} className="mt-6 h-10 rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-700 disabled:opacity-50">Delete test account</button>
        {cleanup === "passed" ? <p role="status" className="mt-4 rounded-md bg-emerald-50 p-4 text-sm text-emerald-800">Account deleted</p> : null}
        {cleanup === "failed" ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-4 text-sm text-red-800">Cleanup failed</p> : null}
      </section>
    </main>
  )
}
