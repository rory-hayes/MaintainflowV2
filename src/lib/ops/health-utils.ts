export function parseContentRangeCount(value: string | null) {
  if (!value) return null
  const match = value.match(/\/(\d+)$/)
  return match ? Number(match[1]) : null
}

type PublicAcquisitionRow = {
  event_name?: unknown
  route?: unknown
  placement?: unknown
  event_count?: unknown
}

export function buildPublicAcquisitionMetrics(rows: PublicAcquisitionRow[]) {
  const pageViews = rows.filter((row) => row.event_name === "public_page_view")
  const ctaClicks = rows.filter((row) => row.event_name === "signup_cta_clicked")
  const pageViewCount = sumEventCounts(pageViews)
  const ctaClickCount = sumEventCounts(ctaClicks)
  const signupPageViews = sumEventCounts(pageViews.filter((row) => row.route === "/sign-up"))

  return {
    pageViews: pageViewCount,
    ctaClicks: ctaClickCount,
    signupPageViews,
    ctaRate: ratio(ctaClickCount, pageViewCount),
    topRoutes: topCounts(pageViews, "route"),
    topPlacements: topCounts(ctaClicks, "placement"),
  }
}

function sumEventCounts(rows: PublicAcquisitionRow[]) {
  return rows.reduce((total, row) => total + eventCount(row), 0)
}

function eventCount(row: PublicAcquisitionRow) {
  const count = Number(row.event_count ?? 1)
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return null
  return Math.round((Math.max(0, numerator) / denominator) * 1_000) / 10
}

function topCounts(rows: PublicAcquisitionRow[], key: "route" | "placement") {
  const counts = rows.reduce<Record<string, number>>((result, row) => {
    const value = typeof row[key] === "string" ? row[key].trim() : ""
    if (value) result[value] = (result[value] ?? 0) + eventCount(row)
    return result
  }, {})

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([label, count]) => ({ label, count }))
}
