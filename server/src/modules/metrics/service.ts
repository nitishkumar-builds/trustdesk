// Observability summary over agent_run (Phase 11 item 1): runs per type and status, latency
// percentiles, token totals and the estimated cost from src/ai/pricing.ts.
import { prisma } from '../../db/prisma.js';
import { priceTable } from '../../ai/pricing.js';

export interface MetricsQuery {
  /** Only runs created at or after this instant. */
  since?: Date;
  /** Only runs of one ticket (also what the tests use to isolate their rows). */
  ticketId?: string;
}

export interface LatencyStats {
  count: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface MetricsSummaryDto {
  generated_at: string;
  window: { since: string | null; ticket_id: string | null };
  runs_total: number;
  runs_by_type: Record<string, number>;
  runs_by_status: Record<string, number>;
  latency: LatencyStats & { by_type: Record<string, LatencyStats> };
  tokens: { prompt: number; completion: number; total: number; runs_with_usage: number; by_model: Record<string, { prompt: number; completion: number; runs: number }> };
  estimated_cost_usd: { total: number; runs_priced: number; runs_unpriced: number; by_model: Record<string, number> };
  pricing: { source: 'default' | 'env'; models: string[]; note: string };
}

/** Nearest-rank percentile (p in 0..1) over a sorted copy; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank]!;
}

function latencyStats(values: number[]): LatencyStats {
  return { count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: values.length ? Math.max(...values) : null };
}

function usageOf(raw: unknown): { prompt: number; completion: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as { prompt?: unknown; completion?: unknown };
  const prompt = typeof u.prompt === 'number' ? u.prompt : 0;
  const completion = typeof u.completion === 'number' ? u.completion : 0;
  return typeof u.prompt === 'number' || typeof u.completion === 'number' ? { prompt, completion } : null;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function metricsSummary(query: MetricsQuery = {}): Promise<MetricsSummaryDto> {
  const runs = await prisma.agentRun.findMany({
    where: {
      ...(query.since ? { createdAt: { gte: query.since } } : {}),
      ...(query.ticketId ? { ticketId: query.ticketId } : {}),
    },
    select: { runType: true, status: true, latencyMs: true, tokenUsage: true, costEstimate: true, modelName: true },
  });

  const runsByType: Record<string, number> = {};
  const runsByStatus: Record<string, number> = {};
  const latencyByType: Record<string, number[]> = {};
  const allLatency: number[] = [];
  const tokens = { prompt: 0, completion: 0, runs_with_usage: 0 };
  const tokensByModel: Record<string, { prompt: number; completion: number; runs: number }> = {};
  let costTotal = 0;
  let runsPriced = 0;
  let runsUnpriced = 0;
  const costByModel: Record<string, number> = {};

  for (const r of runs) {
    runsByType[r.runType] = (runsByType[r.runType] ?? 0) + 1;
    runsByStatus[r.status] = (runsByStatus[r.status] ?? 0) + 1;
    if (typeof r.latencyMs === 'number') {
      allLatency.push(r.latencyMs);
      (latencyByType[r.runType] ??= []).push(r.latencyMs);
    }
    const usage = usageOf(r.tokenUsage);
    if (usage) {
      tokens.prompt += usage.prompt;
      tokens.completion += usage.completion;
      tokens.runs_with_usage += 1;
      const model = r.modelName ?? 'unknown';
      const m = (tokensByModel[model] ??= { prompt: 0, completion: 0, runs: 0 });
      m.prompt += usage.prompt;
      m.completion += usage.completion;
      m.runs += 1;
      // Only model calls (runs that report usage) count as priced or unpriced.
      if (typeof r.costEstimate === 'number') {
        costTotal += r.costEstimate;
        runsPriced += 1;
        costByModel[model] = round6((costByModel[model] ?? 0) + r.costEstimate);
      } else {
        runsUnpriced += 1;
      }
    }
  }

  const pricing = priceTable();
  return {
    generated_at: new Date().toISOString(),
    window: { since: query.since?.toISOString() ?? null, ticket_id: query.ticketId ?? null },
    runs_total: runs.length,
    runs_by_type: runsByType,
    runs_by_status: runsByStatus,
    latency: { ...latencyStats(allLatency), by_type: Object.fromEntries(Object.entries(latencyByType).map(([k, v]) => [k, latencyStats(v)])) },
    tokens: { ...tokens, total: tokens.prompt + tokens.completion, by_model: tokensByModel },
    estimated_cost_usd: { total: round6(costTotal), runs_priced: runsPriced, runs_unpriced: runsUnpriced, by_model: costByModel },
    pricing: {
      source: pricing.source,
      models: Object.keys(pricing.table),
      note: 'Approximate list prices per million tokens (src/ai/pricing.ts); override with AI_PRICE_TABLE_JSON. Runs whose model is not in the table are counted as unpriced.',
    },
  };
}
