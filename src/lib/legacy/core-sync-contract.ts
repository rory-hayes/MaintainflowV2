import { z } from "zod"

const uuidSchema = z.string().uuid()
const timestampSchema = z.string().trim().min(20).max(40).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "A valid timestamp is required."
)
const nullableTimestampSchema = timestampSchema.nullable()

export const legacyClientRowSchema = z.object({
  id: uuidSchema,
  agency_id: uuidSchema,
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  website: z.string().trim().max(2_048),
  owner_user_id: uuidSchema.nullable(),
  report_recipient_email: z.string().trim().email().max(320).nullable(),
  report_cadence: z.enum(["monthly", "quarterly"]),
  notes: z.string().max(10_000),
  archived_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict()

export const legacyWorkflowRowSchema = z.object({
  id: uuidSchema,
  agency_id: uuidSchema,
  client_id: uuidSchema,
  name: z.string().trim().min(1).max(120),
  type: z.enum(["http_endpoint", "webhook", "n8n", "make", "zapier", "mcp_server", "custom_api", "manual_log"]),
  environment: z.enum(["production", "staging", "development"]),
  endpoint_url: z.string().trim().max(2_048),
  method: z.literal("GET"),
  auth_type: z.literal("none"),
  encrypted_auth_config: z.object({ headers: z.array(z.never()).max(0) }).strict(),
  request_body: z.literal(""),
  expected_status: z.number().int().min(100).max(599),
  timeout_seconds: z.number().int().min(1).max(30),
  max_latency_ms: z.number().int().min(100).max(60_000),
  frequency_minutes: z.number().int().min(60).max(43_200),
  retries: z.number().int().min(0).max(10),
  report_included: z.boolean(),
  store_raw_response: z.literal(false),
  status: z.enum(["pending", "healthy", "degraded", "failed", "archived"]),
  health_score: z.number().int().min(0).max(100),
  last_check_run_at: nullableTimestampSchema,
  archived_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict()

const clientUpdateSchema = z.object({
  expectedUpdatedAt: timestampSchema,
  row: legacyClientRowSchema,
}).strict()

const workflowUpdateSchema = z.object({
  expectedUpdatedAt: timestampSchema,
  row: legacyWorkflowRowSchema,
}).strict()

export const legacyCoreSyncRequestSchema = z.discriminatedUnion("table", [
  z.object({
    table: z.literal("clients"),
    creates: z.array(legacyClientRowSchema).max(100),
    updates: z.array(clientUpdateSchema).max(100),
  }).strict(),
  z.object({
    table: z.literal("workflows"),
    creates: z.array(legacyWorkflowRowSchema).max(100),
    updates: z.array(workflowUpdateSchema).max(100),
  }).strict(),
]).superRefine((value, context) => {
  if (value.creates.length + value.updates.length > 100) {
    context.addIssue({ code: "custom", message: "Legacy synchronization accepts at most 100 mutations per request." })
  }
  const ids = [...value.creates.map((row) => row.id), ...value.updates.map((update) => update.row.id)]
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Each legacy row may be mutated only once per request." })
  }
})

export type LegacyClientRow = z.infer<typeof legacyClientRowSchema>
export type LegacyWorkflowRow = z.infer<typeof legacyWorkflowRowSchema>
export type LegacyCoreSyncRequest = z.infer<typeof legacyCoreSyncRequestSchema>
