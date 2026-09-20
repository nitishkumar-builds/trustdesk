/**
 * Phase 11 item 1 — observability: the price table, cost estimates on AgentRun rows and
 * GET /api/metrics/summary (runs per type, p50/p95 latency, tokens, estimated cost).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;

describe('pricing table', () => {
  it('prices known models per million tokens, returns null for unknown models or missing usage, and honours AI_PRICE_TABLE_JSON', async () => {
    delete process.env.AI_PRICE_TABLE_JSON; // the suite asserts the built-in table, whatever the local .env says
    const pricing = await import('../src/ai/pricing.js');
    const { percentile } = await import('../src/modules/metrics/service.js');
    pricing.resetPriceTableCache();
    expect(pricing.estimateCostUsd('mock-rules-v1', { prompt: 1000, completion: 100 })).toBe(0);
    // 1M prompt tokens at $0.30 + 1M completion tokens at $2.50
    expect(pricing.estimateCostUsd('google/gemini-2.5-flash', { prompt: 1_000_000, completion: 1_000_000 })).toBeCloseTo(2.8, 6);
    expect(pricing.estimateCostUsd('google/gemini-2.5-flash', { prompt: 1000, completion: 200 })).toBeCloseTo(0.0008, 6);
    expect(pricing.estimateCostUsd('some/unknown-model', { prompt: 10, completion: 10 })).toBeNull();
    expect(pricing.estimateCostUsd('google/gemini-2.5-flash', null)).toBeNull();
    expect(pricing.estimateCostUsd(null, { prompt: 1, completion: 1 })).toBeNull();
    expect(pricing.priceTable().source).toBe('default');

    // AI_PRICE_TABLE_JSON override: a new model and a changed price for an existing one
    const overridden = pricing.buildPriceTable('{"acme/model-x":{"input_per_million":1,"output_per_million":2},"mock-rules-v1":{"input_per_million":10,"output_per_million":10}}');
    expect(overridden.source).toBe('env');
    expect(pricing.estimateCostUsd('acme/model-x', { prompt: 1_000_000, completion: 500_000 }, overridden.table)).toBeCloseTo(2, 6);
    expect(pricing.estimateCostUsd('mock-rules-v1', { prompt: 100_000, completion: 0 }, overridden.table)).toBeCloseTo(1, 6);
    expect(Object.keys(overridden.table)).toContain('google/gemini-2.5-flash'); // defaults are kept
    expect(() => pricing.buildPriceTable('{"acme/bad":{"input_per_million":"x"}}')).toThrow('acme/bad');
    expect(() => pricing.buildPriceTable('[1]')).toThrow(/JSON object/);

    // nearest-rank percentiles used by the summary
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.95)).toBe(900);
  });
});

describeWithDb('GET /api/metrics/summary (AI_PROVIDER=mock)', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  const runIds: string[] = [];
  const draftIds: string[] = [];
  // Synthetic rows on a ticket id of their own so the summary can be asserted exactly.
  const TICKET = 'tkt_9008';

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    delete process.env.AI_PRICE_TABLE_JSON;
    ({ prisma } = await import('../src/db/prisma.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
  });

  afterAll(async () => {
    if (draftIds.length > 0) await prisma.draftReply.deleteMany({ where: { draftId: { in: draftIds } } });
    if (runIds.length > 0) {
      await prisma.triageResult.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { runId: { in: runIds } } });
    }
    await prisma.$disconnect();
  });

  it('triage and draft runs carry model_name, prompt_version, latency_ms, token_usage and a cost_estimate', async () => {
    const triage = await request(app).post(`/api/tickets/${TICKET}/triage`).set('Authorization', AGENT);
    expect(triage.status).toBe(200);
    runIds.push(triage.body.run_id);
    const draft = await request(app).post(`/api/tickets/${TICKET}/draft-reply`).set('Authorization', AGENT);
    expect(draft.status).toBe(200);
    draftIds.push(draft.body.draft_id);
    runIds.push(draft.body.run_id);
    for (const id of [triage.body.run_id, draft.body.run_id]) {
      const run = await request(app).get(`/api/agent-runs/${id}`).set('Authorization', AGENT);
      expect(run.status).toBe(200);
      expect(run.body.model_name).toBe('mock-rules-v1');
      expect(typeof run.body.prompt_version).toBe('string');
      expect(typeof run.body.latency_ms).toBe('number');
      expect(run.body.token_usage).toMatchObject({ prompt: expect.any(Number), completion: expect.any(Number) });
      expect(run.body.cost_estimate).toBe(0); // the mock is free in the price table
    }
  });

  it('a schema-invalid first answer plus a valid retry reports the tokens and cost of BOTH attempts on the run', async () => {
    const { triageTicket } = await import('../src/modules/triage/service.js');
    const { mergeResponses } = await import('../src/ai/index.js');
    let calls = 0;
    const flaky = {
      name: 'openrouter' as const,
      async complete() {
        calls += 1;
        const bad = { text: '{}', json: { category: 'not-a-category' }, modelProvider: 'openrouter', modelName: 'google/gemini-2.5-flash', latencyMs: 40, tokenUsage: { prompt: 300, completion: 20 }, costEstimate: 0.0001 };
        const good = { text: '{}', json: { category: 'refund', priority: 'medium', sentiment: 'neutral', should_escalate: false, reason_summary: 'ok' }, modelProvider: 'openrouter', modelName: 'google/gemini-2.5-flash', latencyMs: 60, tokenUsage: { prompt: 350, completion: 30 }, costEstimate: 0.0002 };
        return calls === 1 ? bad : good;
      },
    };
    const res = await triageTicket(TICKET, { userId: 'usr_agent', role: 'support_agent' }, { adapter: flaky });
    runIds.push(res.run_id);
    expect(calls).toBe(2);
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { runId: res.run_id } });
    expect(run.tokenUsage).toEqual({ prompt: 650, completion: 50 });
    expect(run.costEstimate).toBeCloseTo(0.0003, 6);
    expect(run.latencyMs).toBe(100);
    expect(run.modelName).toBe('google/gemini-2.5-flash');
    expect((run.guardrailResults as { notes: string[] }).notes).toContain('model_output_retry_succeeded');
    // merge helper edge cases
    expect(mergeResponses([])).toBeNull();
    expect(mergeResponses([{ text: '', modelProvider: 'mock', modelName: 'm', latencyMs: 5 }])).toMatchObject({ latencyMs: 5, tokenUsage: undefined, costEstimate: undefined });
    // a malformed price table fails at boot instead of at the first model call
    const { validatePriceTableJson } = await import('../src/config/env.js');
    expect(() => validatePriceTableJson('{not json')).toThrow();
    expect(() => validatePriceTableJson('{"m":{"input_per_million":-1,"output_per_million":0}}')).toThrow(/non-negative/);
    expect(() => validatePriceTableJson('{"m":{"input_per_million":1,"output_per_million":2}}')).not.toThrow();
  });

  it('summarises runs per type and status, p50/p95 latency, tokens and cost over a window', async () => {
    const since = new Date();
    // Ten synthetic runs with known latencies (10..100 ms), usage and costs, on a ticket-scoped window.
    const { newId } = await import('../src/db/ids.js');
    for (let i = 1; i <= 10; i++) {
      const runId = newId('run');
      runIds.push(runId);
      await prisma.agentRun.create({
        data: {
          runId,
          ticketId: TICKET,
          runType: i <= 6 ? 'triage' : 'draft_reply',
          status: i === 10 ? 'failed' : 'completed',
          retrievedDocIds: [],
          toolCalls: [],
          guardrailResults: { synthetic: true },
          modelProvider: 'openrouter',
          modelName: i === 9 ? 'acme/unpriced' : 'google/gemini-2.5-flash',
          promptVersion: 'triage.v1',
          latencyMs: i * 10,
          tokenUsage: { prompt: 100, completion: 10 },
          costEstimate: i === 9 ? null : 0.0001,
        },
      });
    }
    const res = await request(app).get('/api/metrics/summary').query({ since: since.toISOString(), ticket_id: TICKET }).set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.window).toEqual({ since: since.toISOString(), ticket_id: TICKET });
    expect(res.body.runs_total).toBe(10);
    expect(res.body.runs_by_type).toEqual({ triage: 6, draft_reply: 4 });
    expect(res.body.runs_by_status).toEqual({ completed: 9, failed: 1 });
    expect(res.body.latency).toMatchObject({ count: 10, p50_ms: 50, p95_ms: 100, max_ms: 100 });
    expect(res.body.latency.by_type.triage).toMatchObject({ count: 6, p50_ms: 30, p95_ms: 60, max_ms: 60 });
    expect(res.body.latency.by_type.draft_reply).toMatchObject({ count: 4, p50_ms: 80, p95_ms: 100, max_ms: 100 });
    expect(res.body.tokens).toMatchObject({ prompt: 1000, completion: 100, total: 1100, runs_with_usage: 10 });
    expect(res.body.tokens.by_model['google/gemini-2.5-flash']).toEqual({ prompt: 900, completion: 90, runs: 9 });
    expect(res.body.estimated_cost_usd).toMatchObject({ total: 0.0009, runs_priced: 9, runs_unpriced: 1 });
    expect(res.body.estimated_cost_usd.by_model['google/gemini-2.5-flash']).toBeCloseTo(0.0009, 6);
    expect(res.body.pricing.source).toBe('default');
    expect(res.body.pricing.models).toContain('google/gemini-2.5-flash');

    // the unfiltered summary covers everything and is at least as large
    const all = await request(app).get('/api/metrics/summary').set('Authorization', AGENT);
    expect(all.status).toBe(200);
    expect(all.body.runs_total).toBeGreaterThanOrEqual(10);
    const bad = await request(app).get('/api/metrics/summary').query({ since: 'yesterday' }).set('Authorization', AGENT);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});
