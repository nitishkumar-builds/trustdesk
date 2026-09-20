import { z } from 'zod';

export const ACTION_STATUSES = ['requested', 'approval_required', 'approved', 'rejected', 'executing', 'executed', 'failed', 'cancelled'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

// docs/API_CONTRACT.md section 8: { ticket_id, tool_name, payload: { ..., idempotency_key } }
export const requestActionBodySchema = z.object({
  ticket_id: z.string().min(1),
  tool_name: z.string().min(1),
  payload: z.record(z.unknown()),
});
export type RequestActionBody = z.infer<typeof requestActionBodySchema>;

export const approveBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().min(5).max(2000),
});
export type ApproveBody = z.infer<typeof approveBodySchema>;

export const listActionsQuerySchema = z.object({
  ticket_id: z.string().min(1).optional(),
  status: z.enum(ACTION_STATUSES).optional(),
  tool_name: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const actionIdParamSchema = z.object({ actionId: z.string().min(1) });

// Field-level types for the payload keys that appear in data/tool_actions.json required_fields.
const FIELD_TYPES: Record<string, z.ZodTypeAny> = {
  amount: z.number().positive().finite(),
  idempotency_key: z.string().min(1).max(200),
};

/** Builds a Zod object schema from a tool's required_fields; unknown extra keys are kept. */
export function payloadSchemaFor(requiredFields: string[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of requiredFields) {
    shape[field] = FIELD_TYPES[field] ?? z.string().min(1).max(2000);
  }
  return z.object(shape).passthrough();
}
