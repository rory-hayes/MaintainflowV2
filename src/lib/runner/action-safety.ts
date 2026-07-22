import type { RestrictedAction } from "@/lib/api/business-evals-contracts"

type ClickAction = Extract<RestrictedAction, { type: "click" }>
type CleanupAction = Extract<RestrictedAction, { type: "cleanup" }>

const ACCOUNT_DELETION_PATTERN = /\b(?:delete|destroy|erase|remove|close)\b[\s\S]{0,40}\b(?:account|workspace|profile|user|test\s+account)\b|\b(?:account|workspace|profile|user|test\s+account)\b[\s\S]{0,40}\b(?:delete|destroy|erase|remove|close)\b/i
const PAYMENT_ACTION_PATTERN = /\b(?:pay|purchase|buy\s+now|place\s+(?:the\s+)?order|checkout|confirm\s+payment|charge|refund|subscribe|upgrade\s+(?:the\s+)?plan)\b/i
const EXCLUDED_ORDINARY_CLICK_PATTERN = new RegExp(`${ACCOUNT_DELETION_PATTERN.source}|${PAYMENT_ACTION_PATTERN.source}`, "i")

export function ordinaryClickLooksDestructive(action: ClickAction) {
  return EXCLUDED_ORDINARY_CLICK_PATTERN.test(actionText(action))
}

export function inProductCleanupLooksLikeAccountDeletion(action: CleanupAction) {
  if (action.mode !== "in_product" || !action.locator) return false
  const text = actionText(action)
  return action.locator.kind === "role"
    && action.locator.role === "button"
    && ACCOUNT_DELETION_PATTERN.test(text)
    && !PAYMENT_ACTION_PATTERN.test(text)
}

function actionText(action: ClickAction | CleanupAction) {
  const locator = action.locator
  if (!locator) return action.label
  const locatorText = locator.kind === "role"
    ? `${locator.role} ${locator.name}`
    : locator.kind === "text"
      ? locator.value
      : locator.kind === "label" || locator.kind === "placeholder"
        ? locator.value
        : locator.value
  return `${action.label} ${locatorText}`
}
