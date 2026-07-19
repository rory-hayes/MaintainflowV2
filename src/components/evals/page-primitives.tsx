import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { Fragment, type ReactNode } from "react"
import type { EvalsPaginationState } from "./types"

export function EvalPage({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("mx-auto flex w-full max-w-[1487px] flex-col px-5 pb-10 pt-4 md:px-6", className)}>{children}</main>
}

export function EvalBreadcrumbs({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <Breadcrumb className="mb-4">
      <BreadcrumbList className="gap-1 text-xs text-slate-500 sm:gap-1">
        {items.map((item, index) => (
          <Fragment key={`${item.label}-${index}`}>
            <BreadcrumbItem>
              {item.href ? <BreadcrumbLink render={<Link href={item.href} />}>{item.label}</BreadcrumbLink> : <BreadcrumbPage className="text-slate-500">{item.label}</BreadcrumbPage>}
            </BreadcrumbItem>
            {index < items.length - 1 ? <BreadcrumbSeparator /> : null}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

export function PageHeading({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string
  description?: string
  action?: ReactNode
  eyebrow?: string
}) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">{eyebrow}</p> : null}
        <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.035em] text-slate-950 md:text-[2.5rem]">{title}</h1>
        {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function MetricCard({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return (
    <Card className="gap-3 rounded-lg border border-slate-200 bg-white py-4 shadow-none ring-0">
      <CardHeader className="px-4">
        <CardDescription className="text-xs text-slate-500">{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tracking-tight text-slate-950">{value}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-xs text-slate-500">{detail}</CardContent>
    </Card>
  )
}

export function EmptyPanel({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <Card className="rounded-lg border border-dashed border-slate-300 bg-white py-12 text-center shadow-none ring-0">
      <CardHeader className="mx-auto max-w-lg">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="leading-6">{description}</CardDescription>
      </CardHeader>
      {action ? <CardContent className="flex justify-center">{action}</CardContent> : null}
    </Card>
  )
}

export function CollectionLoadMore({
  state,
  label,
}: {
  state: EvalsPaginationState[keyof EvalsPaginationState]
  label: string
}) {
  if (!state.hasMore) return null
  return (
    <div className="mt-5 flex justify-center">
      <Button
        type="button"
        variant="outline"
        disabled={state.loadingMore}
        onClick={() => void state.loadMore()}
        className="rounded-md border-slate-200 bg-white"
      >
        {state.loadingMore ? "Loading…" : `Load more ${label}`}
      </Button>
    </div>
  )
}
