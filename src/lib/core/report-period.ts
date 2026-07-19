export type ReportPeriod = {
  periodStart: string
  periodEnd: string
}

export function dateInputValue(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function currentMonthToDate(today = new Date()): ReportPeriod {
  return {
    periodStart: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`,
    periodEnd: dateInputValue(today),
  }
}

export function validateReportPeriod(period: ReportPeriod, today = dateInputValue()) {
  if (!period.periodStart) {
    return { field: "periodStart", message: "Period start is required." } as const
  }

  if (!period.periodEnd) {
    return { field: "periodEnd", message: "Period end is required." } as const
  }

  if (period.periodEnd > today) {
    return { field: "periodEnd", message: "Period end cannot be in the future." } as const
  }

  if (period.periodStart > period.periodEnd) {
    return { field: "periodStart", message: "Period start must be before period end." } as const
  }

  const currentMonthStart = `${today.slice(0, 7)}-01`
  if (period.periodStart !== currentMonthStart) {
    return {
      field: "periodStart",
      message: "Reports can currently be generated only for the current UTC month-to-date. Historical rebuilds require audit history.",
    } as const
  }

  if (period.periodEnd !== today) {
    return {
      field: "periodEnd",
      message: "Reports can currently be generated only for the current UTC month-to-date. Historical rebuilds require audit history.",
    } as const
  }

  return null
}

export function isTimestampInReportPeriod(timestamp: string, period: ReportPeriod) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return false
  }

  const inputDate = dateInputValue(date)
  return inputDate >= period.periodStart && inputDate <= period.periodEnd
}
