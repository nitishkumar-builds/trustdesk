/**
 * Approximate model prices (USD per one million tokens) used for `AgentRun.cost_estimate`.
 *
 * These numbers are indicative list prices as of September 2026, entered by hand; providers change
 * them without notice and OpenRouter routes to several upstreams with different prices. Treat every
 * estimate as an order of magnitude, not an invoice. Override or extend the table without a code
 * change through `AI_PRICE_TABLE_JSON`, e.g.
 *   AI_PRICE_TABLE_JSON={"google/gemini-2.5-flash":{"input_per_million":0.3,"output_per_million":2.5}}
 * A model that is in neither table gets `null` (unknown), never a guessed number.
 */
import { env } from '../config/env.js';

export interface ModelPrice {
  input_per_million: number;
  output_per_million: number;
}

export const DEFAULT_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'mock-rules-v1': { input_per_million: 0, output_per_million: 0 },
  'google/gemini-2.5-flash': { input_per_million: 0.3, output_per_million: 2.5 },
  'google/gemini-2.5-flash-lite': { input_per_million: 0.1, output_per_million: 0.4 },
  'google/gemini-2.0-flash-001': { input_per_million: 0.1, output_per_million: 0.4 },
  'openai/gpt-4o-mini': { input_per_million: 0.15, output_per_million: 0.6 },
  'openai/gpt-4.1-mini': { input_per_million: 0.4, output_per_million: 1.6 },
  'anthropic/claude-3.5-haiku': { input_per_million: 0.8, output_per_million: 4 },
});

let cached: { source: 'default' | 'env'; table: Record<string, ModelPrice> } | null = null;

function parseOverrides(raw: string): Record<string, ModelPrice> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI_PRICE_TABLE_JSON must be a JSON object keyed by model name');
  const out: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(parsed as Record<string, unknown>)) {
    const p = price as Partial<ModelPrice> | null;
    if (!p || typeof p.input_per_million !== 'number' || typeof p.output_per_million !== 'number' || p.input_per_million < 0 || p.output_per_million < 0) {
      throw new Error(`AI_PRICE_TABLE_JSON: "${model}" needs numeric input_per_million and output_per_million`);
    }
    out[model] = { input_per_million: p.input_per_million, output_per_million: p.output_per_million };
  }
  return out;
}

/** Builds a price table from the defaults plus an optional JSON override string (override wins per model). */
export function buildPriceTable(rawOverrides: string | undefined): { source: 'default' | 'env'; table: Record<string, ModelPrice> } {
  return rawOverrides ? { source: 'env', table: { ...DEFAULT_PRICE_TABLE, ...parseOverrides(rawOverrides) } } : { source: 'default', table: { ...DEFAULT_PRICE_TABLE } };
}

/** The active price table: defaults merged with `AI_PRICE_TABLE_JSON` (env wins per model). */
export function priceTable(): { source: 'default' | 'env'; table: Record<string, ModelPrice> } {
  if (cached) return cached;
  cached = buildPriceTable(env.AI_PRICE_TABLE_JSON);
  return cached;
}

/** Test hook: forget the cached table so a changed env is re-read. */
export function resetPriceTableCache(): void {
  cached = null;
}

/** USD cost of one call, or null when the model is not priced or no usage was reported. */
export function estimateCostUsd(
  modelName: string | null | undefined,
  usage: { prompt?: number; completion?: number } | null | undefined,
  table: Record<string, ModelPrice> = priceTable().table,
): number | null {
  if (!modelName || !usage) return null;
  const price = table[modelName];
  if (!price) return null;
  const prompt = usage.prompt ?? 0;
  const completion = usage.completion ?? 0;
  const usd = (prompt * price.input_per_million + completion * price.output_per_million) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6; // micro-dollar precision
}
