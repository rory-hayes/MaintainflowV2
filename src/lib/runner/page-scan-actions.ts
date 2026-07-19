export type RawPageScanAction = {
  index: number
  tag: string
  inputType: string
  hasForm: boolean
  disabled: boolean
  label: string
}

export type PageScanSubmitAction = {
  key: string
  label: string
  role: "button"
  locator: { kind: "role"; role: "button"; name: string }
}

export function selectUnambiguousSubmitActions(raw: RawPageScanAction[]): PageScanSubmitAction[] {
  const supported = raw.filter((action) => {
    if (!action.hasForm || action.disabled) return false
    if (action.tag === "button") return action.inputType === "submit"
    return action.tag === "input" && (action.inputType === "submit" || action.inputType === "image")
  })
  const labelCounts = new Map<string, number>()
  supported.forEach((action) => labelCounts.set(action.label, (labelCounts.get(action.label) ?? 0) + 1))

  return supported.flatMap((action) => {
    if (!action.label || labelCounts.get(action.label) !== 1) return []
    return [{
      key: `action-${action.index}`,
      label: action.label,
      role: "button" as const,
      locator: { kind: "role" as const, role: "button" as const, name: action.label },
    }]
  })
}
