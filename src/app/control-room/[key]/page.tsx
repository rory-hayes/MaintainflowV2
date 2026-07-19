import { OpsConsole } from "@/components/ops/ops-console"
import { isOpsRouteKey } from "@/lib/ops/route-key"
import type { Metadata } from "next"
import { notFound } from "next/navigation"

export const metadata: Metadata = {
  title: "Ops Monitor | Maintain Flow",
  robots: {
    index: false,
    follow: false,
  },
}

export default async function OpsMonitorPage({
  params,
}: {
  params: Promise<{ key: string }>
}) {
  const { key } = await params
  if (!isOpsRouteKey(key)) {
    notFound()
  }

  return <OpsConsole />
}
