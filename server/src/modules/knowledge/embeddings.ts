/**
 * Embedding provider behind the hybrid retrieval path (Phase 11 item 3).
 *
 *   EMBEDDING_PROVIDER=local      (default) src/modules/knowledge/localEmbedding.ts — hashing-based,
 *                                 deterministic, no network. This is what the committed eval
 *                                 comparison and the tests use.
 *   EMBEDDING_PROVIDER=openrouter OpenRouter's embeddings endpoint (POST {OPENROUTER_BASE_URL}/embeddings)
 *                                 with OPENROUTER_EMBEDDING_MODEL (default openai/text-embedding-3-small).
 *                                 Needs OPENROUTER_API_KEY; an account whose key cannot reach the
 *                                 embeddings endpoint gets a clear AI_PROVIDER_ERROR at ingest time —
 *                                 nothing silently falls back, so the active model is always the one
 *                                 stored in knowledge_chunk.embedding_model.
 *
 * Embeddings are computed at ingest (seeder, /documents/ingest, /documents/reingest) and stored in
 * knowledge_chunk.embedding; a query is embedded on the fly with the same provider.
 */
import { env } from '../../config/env.js';
import { aiProviderError } from '../../errors/AppError.js';
import { LOCAL_EMBEDDING_MODEL, embedLocal } from './localEmbedding.js';

export interface EmbeddingBatch {
  /** The model slug the chunks are stored under (== provider.model). */
  model: string;
  vectors: number[][];
  /** What the upstream reported it used, when it says so. */
  upstream_model?: string | null;
}

export interface EmbeddingProvider {
  name: 'local' | 'openrouter';
  model: string;
  embed(texts: string[]): Promise<EmbeddingBatch>;
}

const localProvider: EmbeddingProvider = {
  name: 'local',
  model: LOCAL_EMBEDDING_MODEL,
  async embed(texts) {
    return { model: LOCAL_EMBEDDING_MODEL, vectors: texts.map((t) => embedLocal(t)) };
  },
};

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
  error?: { message?: string };
}

function openRouterProvider(fetchImpl: typeof fetch = fetch, apiKey: string = env.OPENROUTER_API_KEY): EmbeddingProvider {
  const model = env.OPENROUTER_EMBEDDING_MODEL;
  return {
    name: 'openrouter',
    model,
    async embed(texts) {
      if (!apiKey) throw aiProviderError('OPENROUTER_API_KEY is not set; EMBEDDING_PROVIDER=openrouter needs it');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.OPENROUTER_TIMEOUT_MS);
      try {
        const res = await fetchImpl(`${env.OPENROUTER_BASE_URL}/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => ({}))) as OpenRouterEmbeddingResponse;
        if (!res.ok) {
          throw aiProviderError(`OpenRouter embeddings request failed with HTTP ${res.status}${data.error?.message ? `: ${data.error.message}` : ''}`, {
            status: res.status,
            model,
            hint: 'If the key cannot use the embeddings endpoint, set EMBEDDING_PROVIDER=local (hashing-based, no network).',
          });
        }
        const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding))) {
          throw aiProviderError('OpenRouter embeddings response did not contain one vector per input', { received: rows.length, expected: texts.length });
        }
        // The stored embedding_model is the slug we asked for (what the vector stage filters on);
        // the upstream's echoed name can differ and is only informational.
        return { model, vectors: rows.map((r) => r.embedding as number[]), upstream_model: data.model ?? null };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw aiProviderError(`OpenRouter embeddings request timed out after ${env.OPENROUTER_TIMEOUT_MS}ms`, { model });
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function getEmbeddingProvider(override?: 'local' | 'openrouter', fetchImpl?: typeof fetch, apiKey?: string): EmbeddingProvider {
  const name = override ?? env.EMBEDDING_PROVIDER;
  return name === 'openrouter' ? openRouterProvider(fetchImpl, apiKey) : localProvider;
}
