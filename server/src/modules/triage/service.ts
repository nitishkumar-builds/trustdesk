import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getAiAdapter, mergeResponses, type AiAdapter, type AiProviderName, type AiResponse } from '../../ai/index.js';
import { mockTriage, type TriageJson } from '../../ai/mockAdapter.js';
import * as triagePrompt from '../../ai/prompts/triage.v1.js';
import { newId } from '../../db/ids.js';
import { prisma } from '../../db/prisma.js';
import { AppError, notFoundError } from '../../errors/AppError.js';
import type { Principal } from '../../middleware/auth.js';
import { searchKnowledge } from '../knowledge/search.js';
import { mapOrder } from '../orders/mappers.js';
import { buildPolicyContext } from '../tickets/service.js';
import { applyPostRules, type FiredRule } from './postRules.js';

const RETRIEVAL_LIMIT = 4;

export const triageOutputSchema = z.object({
  category: z.enum(triagePrompt.TRIAGE_CATEGORIES),
  priority: z.enum(triagePrompt.TRIAGE_PRIORITIES),
  sentiment: z.enum(triagePrompt.TRIAGE_SENTIMENTS),
  should_escalate: z.boolean(),
  reason_summary: z.string().min(1).max(1000),
});

export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...triagePrompt.TRIAGE_CATEGORIES] },
    priority: { type: 'string', enum: [...triagePrompt.TRIAGE_PRIORITIES] },
    sentiment: { type: 'string', enum: [...triagePrompt.TRIAGE_SENTIMENTS] },
    should_escalate: { type: 'boolean' },
    reason_summary: { type: 'string' },
  },
  required: ['category', 'priority', 'sentiment', 'should_escalate', 'reason_summary'],
} as const;

export interface TriageResponseDto {
  ticket_id: string;
  category: string;
  priority: string;
  sentiment: string;
  should_escalate: boolean;
  reason_summary: string;
  run_id: string;
  fired_rules: FiredRule[];
}

export interface TriageOptions {
  /** Used by the eval runner to force a provider; defaults to env.AI_PROVIDER. */
  provider?: AiProviderName;
  /** A ready adapter (the eval runner wraps the real one to observe prompt payloads); wins over provider. */
  adapter?: AiAdapter;
  /** Retrieval mode override (default env.RETRIEVAL_MODE); the eval runner compares fts vs hybrid. */
  retrievalMode?: 'fts' | 'hybrid';
}

export async function triageTicket(
  ticketId: string,
  principal: Principal,
  options: TriageOptions = {},
): Promise<TriageResponseDto> {
  // 1. Load ticket + customer + order (never the expectation — rule R2) and compute policy facts.
  const ticket = await prisma.ticket.findUnique({
    where: { ticketId },
    include: { customer: true, order: true },
  });
  if (!ticket) throw notFoundError(`Ticket ${ticketId} not found`);
  const policyContext = buildPolicyContext(ticket); // asOf = ticket.createdAt (rule R1)

  // 2. Retrieve grounding chunks. No categoryHint yet: the category is what we are deciding.
  const { results: retrieved, mode: retrievalMode } = await searchKnowledge({
    query: `${ticket.subject} ${ticket.body}`,
    limit: RETRIEVAL_LIMIT,
    mode: options.retrievalMode,
  });
  const retrievedDocIds = [...new Set(retrieved.map((r) => r.doc_id))];

  // 3–4. Model call with validation, one corrective retry, then deterministic fallback.
  const adapter = options.adapter ?? getAiAdapter(options.provider);
  const user = triagePrompt.buildUser({
    ticket,
    customer: ticket.customer,
    order: ticket.order ? mapOrder(ticket.order) : null,
    policyContext,
    retrieved,
  });
  const started = Date.now();
  const notes: string[] = [];
  let modelJson: TriageJson;
  let response: AiResponse | null;
  try {
    ({ json: modelJson, response } = await completeWithValidation(adapter, user, notes, ticket));
  } catch (err) {
    // Rule R7: a provider failure is still a triage run; record it as failed before the error surfaces.
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : String(err);
    await prisma.agentRun.create({
      data: {
        runId: newId('run'),
        ticketId: ticket.ticketId,
        runType: 'triage',
        status: 'failed',
        retrievedDocIds,
        toolCalls: [],
        guardrailResults: { fired_rules: [], notes: [...notes, `provider_error: ${message}`], model_output: null, final_output: null } as unknown as Prisma.InputJsonObject,
        modelProvider: adapter.name,
        promptVersion: triagePrompt.version,
        latencyMs: Date.now() - started,
      },
    });
    throw err;
  }

  // 5. Deterministic post-rules override the model.
  const customerText = `${ticket.subject}\n${ticket.body}`;
  const { result, fired } = applyPostRules(customerText, modelJson);

  // 6. Persist the trace (rule R7) and the triage result.
  const runId = newId('run');
  const guardrailResults = {
    fired_rules: fired,
    notes,
    model_output: modelJson,
    final_output: result,
    retrieval_mode: retrievalMode,
  };
  await prisma.$transaction([
    prisma.agentRun.create({
      data: {
        runId,
        ticketId: ticket.ticketId,
        runType: 'triage',
        status: 'completed',
        retrievedDocIds,
        toolCalls: [],
        guardrailResults: guardrailResults as unknown as Prisma.InputJsonObject,
        modelProvider: response?.modelProvider ?? adapter.name,
        modelName: response?.modelName || null,
        promptVersion: triagePrompt.version,
        latencyMs: response?.latencyMs ?? Date.now() - started,
        tokenUsage: response?.tokenUsage ? (response.tokenUsage as Prisma.InputJsonObject) : undefined,
        costEstimate: response?.costEstimate ?? null,
      },
    }),
    prisma.triageResult.create({
      data: {
        ticketId: ticket.ticketId,
        category: result.category,
        priority: result.priority,
        sentiment: result.sentiment,
        shouldEscalate: result.should_escalate,
        reasonSummary: result.reason_summary,
        runId,
      },
    }),
  ]);

  void principal; // the actor is not stored on AgentRun (no column); kept for future audit use

  // 7. API shape (docs/API_CONTRACT.md section 5) plus fired_rules.
  return {
    ticket_id: ticket.ticketId,
    category: result.category,
    priority: result.priority,
    sentiment: result.sentiment,
    should_escalate: result.should_escalate,
    reason_summary: result.reason_summary,
    run_id: runId,
    fired_rules: fired,
  };
}

async function completeWithValidation(
  adapter: AiAdapter,
  user: string,
  notes: string[],
  ticket: { subject: string; body: string },
): Promise<{ json: TriageJson; response: AiResponse | null }> {
  // Every attempt's response is kept so the trace reports the tokens and cost of the whole call (D-074).
  const responses: AiResponse[] = [];
  const attempt = async (extraSystem: string): Promise<TriageJson | null> => {
    const response = await adapter.complete({
      promptVersion: triagePrompt.version,
      system: extraSystem ? `${triagePrompt.system}\n\n${extraSystem}` : triagePrompt.system,
      user,
      jsonSchema: TRIAGE_JSON_SCHEMA,
      temperature: 0.1,
    });
    responses.push(response);
    const parsed = triageOutputSchema.safeParse(response.json);
    if (parsed.success) return parsed.data;
    notes.push(`model_output_invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return null;
  };

  const first = await attempt('');
  if (first) return { json: first, response: mergeResponses(responses) };

  const second = await attempt(
    'Your previous answer was not valid JSON with the required keys and enum values. Answer again with ONLY the JSON object.',
  );
  if (second) {
    notes.push('model_output_retry_succeeded');
    return { json: second, response: mergeResponses(responses) };
  }

  // Fallback: the mock rules answer, but the paid attempts' usage still lands on the run
  // (model_name stays null so the fallback remains visible, D-033).
  notes.push('model_output_invalid_fallback_applied');
  const fallback = mockTriage(`${ticket.subject}\n${ticket.body}`);
  const merged = mergeResponses(responses);
  return { json: fallback.json, response: merged ? { ...merged, modelName: '' } : null };
}
