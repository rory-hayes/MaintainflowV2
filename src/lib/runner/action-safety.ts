import type { RestrictedAction } from "@/lib/api/business-evals-contracts"

const EXCLUDED_ORDINARY_CLICK_PATTERN = /\b(?:delete|destroy|erase|remove\s+(?:the\s+)?account|close\s+(?:the\s+)?account|pay|purchase|buy\s+now|place\s+(?:the\s+)?order|checkout|confirm\s+payment|charge|refund|subscribe|upgrade\s+(?:the\s+)?plan)\b/i

export function ordinaryClickLooksDestructive(action: Extract<RestrictedAction, { type: "click" }>) {
  const locatorText = action.locator.kind === "role"
    ? `${action.locator.role} ${action.locator.name}`
    : action.locator.kind === "text"
      ? action.locator.value
      : action.locator.kind === "label" || action.locator.kind === "placeholder"
        ? action.locator.value
        : action.locator.value
  return EXCLUDED_ORDINARY_CLICK_PATTERN.test(`${action.label} ${locatorText}`)
}
