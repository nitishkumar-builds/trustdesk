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
      return { ...res, costEstimate: estimateCostUsd(res.modelName, res.tokenUsage) ?? res.costEstimate };
    },
  };
}

// Returns the adapter named by env.AI_PROVIDER; the eval runner passes an explicit override.
export function getAiAdapter(override?: AiProviderName): AiAdapter {
  return withCostEstimate(adapters[override ?? env.AI_PROVIDER]());
}

export type { AiAdapter, AiProviderName, AiRequest, AiResponse } from './types.js';
