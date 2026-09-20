import { z } from 'zod';
import { DRAFT_CONFIDENCE } from '../../ai/prompts/draftReply.v1.js';

export const DRAFT_STATUSES = ['generated', 'edited', 'approved', 'rejected', 'sent'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const ticketIdParamSchema = z.object({ ticketId: z.string().min(1) });
export const draftIdParamSchema = z.object({ draftId: z.string().min(1) });

export const patchDraftBodySchema = z.object({
  status: z.enum(['edited', 'approved', 'rejected', 'sent']),
  body: z.string().min(1).max(20000).optional(),
  reason: z.string().min(1).max(2000).optional(),
});
export type PatchDraftBody = z.infer<typeof patchDraftBodySchema>;

// What the model must return for draftReply.v1.
export const draftOutputSchema = z.object({
  body: z.string().min(1).max(20000),
  citations: z.array(z.string().min(1)).max(20),
  recommended_actions: z
    .array(z.object({ tool_name: z.string().min(1), reason: z.string().min(1).max(500) }))
    .max(10),
  confidence: z.enum(DRAFT_CONFIDENCE),
});
export type DraftOutput = z.infer<typeof draftOutputSchema>;

export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    body: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
    recommended_actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, reason: { type: 'string' } },
        required: ['tool_name', 'reason'],
      },
    },
    confidence: { type: 'string', enum: [...DRAFT_CONFIDENCE] },
  },
  required: ['body', 'citations', 'recommended_actions', 'confidence'],
} as const;
