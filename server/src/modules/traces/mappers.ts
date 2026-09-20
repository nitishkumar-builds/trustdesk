import type { AgentRun } from '@prisma/client';

export interface AgentRunDto {
  run_id: string;
  ticket_id: string | null;
  run_type: string;
  status: string;
  retrieved_doc_ids: string[];
  tool_calls: unknown;
  guardrail_results: unknown;
  model_provider: string | null;
  model_name: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  token_usage: unknown | null;
  cost_estimate: number | null;
  created_at: string;
}

export function mapAgentRun(r: AgentRun): AgentRunDto {
  return {
    run_id: r.runId,
    ticket_id: r.ticketId,
    run_type: r.runType,
    status: r.status,
    retrieved_doc_ids: r.retrievedDocIds,
    tool_calls: r.toolCalls,
    guardrail_results: r.guardrailResults,
    model_provider: r.modelProvider,
    model_name: r.modelName,
    prompt_version: r.promptVersion,
    latency_ms: r.latencyMs,
    token_usage: r.tokenUsage ?? null,
    cost_estimate: r.costEstimate,
    created_at: r.createdAt.toISOString(),
  };
}
