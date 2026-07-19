export function EvalsRouteFallback() {
  return (
    <div className="min-h-dvh bg-[#fbfaf7] text-slate-950" aria-busy="true" aria-label="Loading Maintain Flow">
      <header className="h-[58px] border-b border-slate-200 bg-[#fbfaf7]" />
      <main className="mx-auto max-w-[1487px] px-5 py-8 md:px-6">
        <div className="h-7 w-44 animate-pulse rounded bg-slate-200" />
        <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-slate-100" />
        <div className="mt-8 h-56 animate-pulse rounded-lg border border-slate-200 bg-white" />
      </main>
    </div>
  )
}
