export type WorkspaceReadinessInput = {
  authReady: boolean
  hasUser: boolean
  coreLoading: boolean
  creatingAgency: boolean
  hasAgency: boolean
  pathname: string | null
}

export function resolveWorkspaceReadiness(input: WorkspaceReadinessInput) {
  const authenticated = input.authReady && input.hasUser
  const workspacePending = authenticated && (input.coreLoading || input.creatingAgency)
  const workspaceReady = authenticated && input.hasAgency && !workspacePending
  const onOnboarding = input.pathname === "/onboarding"

  return {
    authLoading: !input.authReady,
    workspacePending,
    workspaceReady,
    appActionsEnabled: workspaceReady,
    shouldRedirectToOnboarding: authenticated && !input.hasAgency && !workspacePending && !onOnboarding,
  }
}
