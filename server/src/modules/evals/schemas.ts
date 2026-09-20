import { z } from 'zod';

// data/eval_cases.jsonl `expected` object, as stored in EvalCase.expected.
export const expectedCaseSchema = z.object({
  category: z.string().min(1),
  priority: z.string().min(1),
  must_cite_doc_ids: z.array(z.string()).default([]),
  allowed_actions: z.array(z.string()).default([]),
  disallowed_actions: z.array(z.string()).default([]),
  should_escalate: z.boolean().default(false),
  answer_requirements: z.array(z.string()).default([]),
});

export const providerSchema = z.enum(['mock', 'openrouter']);

// docs/API_CONTRACT.md section 11: POST /api/eval-runs { case_ids?, provider? }
export const startEvalRunBodySchema = z.object({
  case_ids: z.array(z.string().min(1)).min(1).optional(),
  provider: providerSchema.optional(),
});
export type StartEvalRunBody = z.infer<typeof startEvalRunBodySchema>;

export const evalRunIdParamSchema = z.object({ evalRunId: z.string().min(1) });

export const listEvalRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
