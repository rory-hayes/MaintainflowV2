import type { CurrentLegalAcceptance } from "../legal/acceptance.ts"

export type EmailActionOrchestrationInput =
  | { type: "email"; tokenHash: string }
  | {
      type: "recovery"
      tokenHash: string
      password: string
      legalAcceptance: CurrentLegalAcceptance
    }

export type VerifiedEmailActionSession = {
  accessToken: string
  userId: string
}

type EmailActionDependencies = {
  verify(type: EmailActionOrchestrationInput["type"], tokenHash: string): Promise<VerifiedEmailActionSession>
  requireSignupLegalAcceptance(userId: string): Promise<void>
  activateSignupAccount(userId: string): Promise<void>
  recordRecoveryLegalAcceptance(
    userId: string,
    tokenHash: string,
    acceptance: CurrentLegalAcceptance,
  ): Promise<void>
  updatePassword(session: VerifiedEmailActionSession, password: string): Promise<void>
  revoke(accessToken: string): Promise<void>
}

export class EmailActionRevocationError extends Error {
  readonly actionType: EmailActionOrchestrationInput["type"]

  constructor(actionType: EmailActionOrchestrationInput["type"]) {
    super("The temporary email-action session could not be revoked.")
    this.name = "EmailActionRevocationError"
    this.actionType = actionType
  }
}

export async function completeEmailActionWithDependencies(
  action: EmailActionOrchestrationInput,
  dependencies: EmailActionDependencies,
) {
  const session = await dependencies.verify(action.type, action.tokenHash)
  let result: { confirmed: true } | { passwordUpdated: true }
  let actionError: unknown

  try {
    if (action.type === "email") {
      await dependencies.requireSignupLegalAcceptance(session.userId)
      await dependencies.activateSignupAccount(session.userId)
      result = { confirmed: true }
    } else {
      await dependencies.recordRecoveryLegalAcceptance(session.userId, action.tokenHash, action.legalAcceptance)
      await dependencies.updatePassword(session, action.password)
      result = { passwordUpdated: true }
    }
  } catch (error) {
    actionError = error
    result = action.type === "email" ? { confirmed: true } : { passwordUpdated: true }
  }

  try {
    await dependencies.revoke(session.accessToken)
  } catch {
    throw new EmailActionRevocationError(action.type)
  }

  if (actionError) throw actionError
  return result
}
