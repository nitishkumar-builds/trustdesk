import { env } from '../config/env.js';
import { MockAdapter } from './mockAdapter.js';
import { OpenRouterAdapter } from './openRouterAdapter.js';
import type { AiAdapter, AiProviderName } from './types.js';

const adapters: Record<AiProviderName, () => AiAdapter> = {
  mock: () => new MockAdapter(),
  openrouter: () => new OpenRouterAdapter(),
};

// Returns the adapter named by env.AI_PROVIDER; the eval runner passes an explicit override.
export function getAiAdapter(override?: AiProviderName): AiAdapter {
  return adapters[override ?? env.AI_PROVIDER]();
}

export type { AiAdapter, AiProviderName, AiRequest, AiResponse } from './types.js';
