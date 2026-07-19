export type WorkflowWizardField =
  | "newClientName"
  | "workflowName"
  | "endpointUrl"
  | "curl"
  | "importPayload"

export type WorkflowWizardError = {
  field: WorkflowWizardField
  message: string
}

export type WorkflowWizardDraft = {
  newClientName: string
  workflowName: string
  endpointUrl: string
  curl: string
  importPayload: string
}

export type WorkflowSetupMethod = "endpoint" | "curl" | "import"

export const workflowWizardInitialDraft: WorkflowWizardDraft = {
  newClientName: "",
  workflowName: "",
  endpointUrl: "",
  curl: "",
  importPayload: "",
}

export const workflowWizardPlaceholders = {
  clientName: "Acme AI Systems",
  clientEmail: "ops@client.com",
  workflowName: "Lead enrichment health check",
  endpointUrl: "https://status.client.com/customer-outcome-health",
  curl: "curl https://status.client.com/customer-outcome-health",
  importPayload: "{\"name\":\"Lead intake workflow\",\"nodes\":[{\"webhookUrl\":\"https://api.client.com/webhook\"}]}",
} as const

export function validateWorkflowClientStep(input: { fixedClientId?: string; clientId: string; newClientName: string }) {
  if (!input.fixedClientId && input.clientId === "new" && !input.newClientName.trim()) {
    return { field: "newClientName", message: "Client name is required." } satisfies WorkflowWizardError
  }

  return null
}

export function validateWorkflowConfigureStep(input: {
  setupMethod: WorkflowSetupMethod
  workflowName: string
  endpointUrl: string
  curl: string
  importPayload: string
}) {
  if (!input.workflowName.trim()) {
    return { field: "workflowName", message: "Workflow name is required." } satisfies WorkflowWizardError
  }

  if (input.setupMethod === "curl" && !input.curl.trim()) {
    return { field: "curl", message: "cURL command is required." } satisfies WorkflowWizardError
  }

  if (input.setupMethod === "import" && !input.importPayload.trim()) {
    return { field: "importPayload", message: "Import payload is required." } satisfies WorkflowWizardError
  }

  if (input.setupMethod === "endpoint" && !input.endpointUrl.trim()) {
    return { field: "endpointUrl", message: "Endpoint URL is required." } satisfies WorkflowWizardError
  }

  return null
}
