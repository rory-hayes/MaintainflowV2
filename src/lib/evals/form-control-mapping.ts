import type { JourneyAction, LocatorDefinition } from "./types.ts"

export const safeSyntheticValueKeys = [
  "first_name",
  "last_name",
  "full_name",
  "name",
  "email",
  "company",
  "workspace",
  "message",
  "password",
  "number",
  "url",
  "marker",
] as const

export type SafeSyntheticValueKey = (typeof safeSyntheticValueKeys)[number]

export type ScannedFormField = {
  key: string
  control: "input" | "textarea" | "select"
  inputType: string
  label: string
  name: string
  required: boolean
  options: Array<{ value: string; label: string; disabled: boolean }>
  locator: Extract<LocatorDefinition, { kind: "label" | "placeholder" | "test_id" }> | null
}

export type RadioFieldGroup = {
  key: string
  name: string
  required: boolean
  ambiguous: boolean
  fields: ScannedFormField[]
}

export function isCheckboxField(field: ScannedFormField) {
  return field.control === "input" && field.inputType.toLowerCase() === "checkbox"
}

export function isRadioField(field: ScannedFormField) {
  return field.control === "input" && field.inputType.toLowerCase() === "radio"
}

export function isPhoneLikeField(field: ScannedFormField) {
  // Consent controls may mention phone or SMS in their label, but they never
  // receive contact data. They are handled by the explicit opt-in mapping.
  if (isCheckboxField(field) || isRadioField(field)) return false
  const identity = `${field.label} ${field.name} ${field.inputType}`.toLowerCase()
  return field.inputType.toLowerCase() === "tel" || /\b(phone|mobile|telephone|tel|sms)\b/.test(identity)
}

export function isSupportedFormField(field: ScannedFormField) {
  if (!field.locator || isPhoneLikeField(field)) return false
  if (field.control === "textarea") return true
  if (field.control === "select") return field.options.some((option) => !option.disabled)
  if (field.control !== "input") return false

  const inputType = field.inputType.toLowerCase()
  if (inputType === "checkbox") return field.options[0]?.disabled !== true
  if (inputType === "radio") return Boolean(field.name.trim()) && field.options[0]?.disabled !== true
  return new Set(["", "text", "email", "password", "search", "number", "url"]).has(inputType)
}

export function isSyntheticTextField(field: ScannedFormField) {
  return isSupportedFormField(field)
    && (field.control === "textarea" || (field.control === "input" && !isCheckboxField(field) && !isRadioField(field)))
}

export function inferSyntheticValueKey(field: ScannedFormField): SafeSyntheticValueKey {
  if (isPhoneLikeField(field)) {
    throw new Error(`${field.label} is a telephone or messaging field and cannot receive synthetic contact data.`)
  }
  const identity = `${field.label} ${field.name} ${field.inputType}`.toLowerCase()
  if (/e-?mail/.test(identity)) return "email"
  if (field.inputType.toLowerCase() === "number" || /\b(number|quantity|employees|team size)\b/.test(identity)) return "number"
  if (field.inputType.toLowerCase() === "url" || /\b(website|url|site)\b/.test(identity)) return "url"
  if (/first/.test(identity)) return "first_name"
  if (/last/.test(identity)) return "last_name"
  if (/full.?name/.test(identity)) return "full_name"
  if (/company|organisation|organization/.test(identity)) return "company"
  if (/workspace|team/.test(identity)) return "workspace"
  if (/message|notes?|comments?|details|enquiry|inquiry/.test(identity)) return "message"
  if (/password/.test(identity)) return "password"
  if (/name/.test(identity)) return "name"
  return field.control === "textarea" ? "message" : "marker"
}

export function groupRadioFields(fields: ScannedFormField[]): RadioFieldGroup[] {
  const groups = new Map<string, RadioFieldGroup>()
  for (const field of fields.filter(isRadioField)) {
    const name = field.name.trim()
    const key = name ? `name:${name}` : `ambiguous:${field.key}`
    const current = groups.get(key) ?? {
      key,
      name,
      required: false,
      ambiguous: !name,
      fields: [],
    }
    current.fields.push(field)
    current.required ||= field.required
    groups.set(key, current)
  }
  return [...groups.values()]
}

export function controlMappingsAreReady(input: {
  fields: ScannedFormField[]
  approvedCheckboxes: Record<string, boolean>
  radioChoices: Record<string, string>
}) {
  const requiredCheckboxesReady = input.fields
    .filter(isCheckboxField)
    .every((field) => !field.required || (isSupportedFormField(field) && input.approvedCheckboxes[field.key] === true))

  const radioGroupsReady = groupRadioFields(input.fields).every((group) => {
    const selectedKey = input.radioChoices[group.key] ?? ""
    if (group.ambiguous) return !group.required && !selectedKey
    if (!selectedKey) return !group.required
    return group.fields.some((field) => field.key === selectedKey && isSupportedFormField(field))
  })

  return requiredCheckboxesReady && radioGroupsReady
}

export function compileOperatorApprovedCheckActions(input: {
  fields: ScannedFormField[]
  approvedCheckboxes: Record<string, boolean>
  radioChoices: Record<string, string>
}): JourneyAction[] {
  const selectedRadioFields = new Map<string, ScannedFormField>()
  for (const group of groupRadioFields(input.fields)) {
    const selectedKey = input.radioChoices[group.key] ?? ""
    if (group.ambiguous) {
      if (group.required || selectedKey) {
        throw new Error(`Radio option ${group.fields[0]?.label ?? "without a group name"} cannot be published because its semantic group is ambiguous.`)
      }
      continue
    }
    if (!selectedKey) {
      if (group.required) throw new Error(`Choose one operator-approved option for required radio group ${group.name}.`)
      continue
    }
    const selected = group.fields.find((field) => field.key === selectedKey)
    if (!selected || !isSupportedFormField(selected)) {
      throw new Error(`Choose one enabled semantic option for radio group ${group.name}.`)
    }
    selectedRadioFields.set(selected.key, selected)
  }

  const actions: JourneyAction[] = []
  input.fields.forEach((field, index) => {
    if (isCheckboxField(field)) {
      const approved = input.approvedCheckboxes[field.key] === true
      if (!approved) {
        if (field.required) throw new Error(`Explicitly approve the required checkbox ${field.label} or remove it from the target journey.`)
        return
      }
      if (!isSupportedFormField(field) || !field.locator) {
        throw new Error(`Checkbox ${field.label} does not have one enabled semantic target.`)
      }
      actions.push({
        id: `check_${safeFieldKey(field.key)}_${index}`,
        label: `Select operator-approved checkbox ${field.label}`,
        type: "fill",
        operation: "check",
        locator: field.locator,
        expectedChecked: true,
        controlKind: "checkbox",
        operatorApproved: true,
        timeoutMs: 10_000,
      })
      return
    }

    if (!isRadioField(field) || !selectedRadioFields.has(field.key) || !field.locator) return
    actions.push({
      id: `check_${safeFieldKey(field.key)}_${index}`,
      label: `Select operator-approved radio option ${field.label}`,
      type: "fill",
      operation: "check",
      locator: field.locator,
      expectedChecked: true,
      controlKind: "radio",
      operatorApproved: true,
      radioGroup: field.name.trim(),
      timeoutMs: 10_000,
    })
  })
  return actions
}

function safeFieldKey(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_")
}
