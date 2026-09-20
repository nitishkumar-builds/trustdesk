import { env } from '../config/env.js';
import { MockAdapter } from './mockAdapter.js';
import { OpenRouterAdapter } from './openRouterAdapter.js';
import { estimateCostUsd } from './pricing.js';
import type { AiAdapter, AiProviderName, AiRequest, AiResponse } from './types.js';

const adapters: Record<AiProviderName, () => AiAdapter> = {
  mock: () => new MockAdapter(),
  openrouter: () => new OpenRouterAdapter(),
};

// Attaches cost_estimate (USD, from the price table) to every response so AgentRun writers do not
// each have to know about pricing.
function withCostEstimate(inner: AiAdapter): AiAdapter {
  return {
    name: inner.name,
    async complete(req: AiRequest): Promise<AiResponse> {
      const res = await inner.complete(req);
      let cost: number | null = null;
      try {
        cost = estimateCostUsd(res.modelName, res.tokenUsage);
      } catch {
        cost = null; // a pricing-table problem must never fail a triage or a draft (env.ts also validates it at boot)
      }
      return { ...res, costEstimate: cost ?? res.costEstimate };
    },
  };
}

/**
 * Sums the usage of every attempt of one logical call (the validation retry, D-033), so tokens and
 * cost are never under-reported; provider/model come from the last real response.
 */
export function mergeResponses(responses: AiResponse[]): AiResponse | null {
  const last = responses[responses.length - 1];
  if (!last) return null;
  const withUsage = responses.filter((r) => r.tokenUsage);
  const tokenUsage = withUsage.length
    ? withUsage.reduce((acc, r) => ({ prompt: acc.prompt + (r.tokenUsage?.prompt ?? 0), completion: acc.completion + (r.tokenUsage?.completion ?? 0) }), { prompt: 0, completion: 0 })
    : undefined;
  const priced = responses.filter((r) => typeof r.costEstimate === 'number');
  const costEstimate = priced.length ? priced.reduce((acc, r) => acc + (r.costEstimate ?? 0), 0) : undefined;
  return {
    ...last,
    latencyMs: responses.reduce((acc, r) => acc + r.latencyMs, 0),
    tokenUsage,
    costEstimate: costEstimate === undefined ? undefined : Math.round(costEstimate * 1e6) / 1e6,
  };
}

// Returns the adapter named by env.AI_PROVIDER; the eval runner passes an explicit override.
export function getAiAdapter(override?: AiProviderName): AiAdapter {
  return withCostEstimate(adapters[override ?? env.AI_PROVIDER]());
}

export type { AiAdapter, AiProviderName, AiRequest, AiResponse } from './types.js';
