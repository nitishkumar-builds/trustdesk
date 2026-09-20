/**
 * Phase 11 item 3, post-review: the env-driven hybrid path (RETRIEVAL_MODE=hybrid with no per-call
 * override) reaches triage and drafts through the API, and the report's fts-vs-hybrid section is
 * carried forward across plain runs with an explicit staleness line.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;

describe('report: retrieval comparison carry-forward (no DB)', () => {
  it('keeps the previous comparison table when the current run has none, and says which run measured it', async () => {
    const { renderEvaluationReport, RETRIEVAL_SECTION_HEADING } = await import('../src/modules/evals/report.js');
    const metrics = { category_accuracy: 1, priority_accuracy: 1, triage_accuracy: 1, citation_coverage: 1, unsafe_action_block_rate: 1, allowed_action_recall: 1, escalation_accuracy: 1, answer_requirement_coverage: 1 };
    const base = {
      eval_run_id: 'eval_run_first',
      status: 'completed' as const,
      total_cases: 0,
      provider: 'mock' as const,
      started_at: '2026-09-20T00:00:00.000Z',
      completed_at: '2026-09-20T00:00:01.000Z',
      metrics,
      case_results: [],
      case_details: [],
      adversarial_summary: [],
      run_metadata: { provider: 'mock' as const, retrieval_mode: 'fts' as const, retrieval_comparison: null, model_names: [], prompt_versions: [], case_ids: [], started_at: '2026-09-20T00:00:00.000Z', completed_at: null, duration_ms: null, report_paths: { json: null, markdown: null }, report_error: null },
      error: null,
    };
    const withComparison = {
      ...base,
      run_metadata: { ...base.run_metadata, retrieval_comparison: { fts: metrics, hybrid: { ...metrics, citation_coverage: 0.875 }, baseline_mode: 'fts' as const, embedding_model: 'local-hash-v1', per_case: [{ case_id: 'eval_001', fts_passed: true, hybrid_passed: false, fts_citations: ['KB-REFUND-001'], hybrid_citations: [] }] } },
    };
    const first = renderEvaluationReport(withComparison, null);
    expect(first).toContain(RETRIEVAL_SECTION_HEADING);
    expect(first).toContain('| `citation_coverage` | 1.000 | 0.875 |');
    expect(first).toContain('Measured by run `eval_run_first`');

    const second = renderEvaluationReport({ ...base, eval_run_id: 'eval_run_second' }, first);
    expect(second).toContain('| `citation_coverage` | 1.000 | 0.875 |'); // carried forward
    expect(second).toContain('Measured by run `eval_run_first`');
    expect(second).toContain('not by this run (`eval_run_second`)');
    const third = renderEvaluationReport({ ...base, eval_run_id: 'eval_run_third' }, second);
    expect(third).toContain('Measured by run `eval_run_first`');
    expect(third.match(/not by this run/g)).toHaveLength(1); // the staleness line is not stacked

    const none = renderEvaluationReport(base, null);
    expect(none).toContain('No comparison in this run');
  });
});

describeWithDb('RETRIEVAL_MODE=hybrid from the environment reaches triage and drafts through the API', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  const draftIds: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    process.env.RETRIEVAL_MODE = 'hybrid'; // read once by env.ts at first import
    process.env.EMBEDDING_PROVIDER = 'local';
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

  it('triage and draft traces record retrieval_mode hybrid, the draft still cites the required policy, and search echoes the mode', async () => {
    const { env } = await import('../src/config/env.js');
    expect(env.RETRIEVAL_MODE).toBe('hybrid');
    const triage = await request(app).post('/api/tickets/tkt_9002/triage').set('Authorization', AGENT);
    expect(triage.status).toBe(200);
    runIds.push(triage.body.run_id);
    const draft = await request(app).post('/api/tickets/tkt_9002/draft-reply').set('Authorization', AGENT);
    expect(draft.status).toBe(200);
    draftIds.push(draft.body.draft_id);
    runIds.push(draft.body.run_id);
    expect(draft.body.citations).toContain('KB-SHIPPING-001');
    for (const id of [triage.body.run_id, draft.body.run_id]) {
      const run = await request(app).get(`/api/agent-runs/${id}`).set('Authorization', AGENT);
      expect(run.body.guardrail_results.retrieval_mode).toBe('hybrid');
      expect(run.body.retrieved_doc_ids).not.toContain('KB-ADVERSARIAL-001');
    }
    const search = await request(app).get('/api/documents/search').query({ q: 'package has not moved' }).set('Authorization', AGENT);
    expect(search.body.mode).toBe('hybrid');
    const forced = await request(app).get('/api/documents/search').query({ q: 'package has not moved', mode: 'fts' }).set('Authorization', AGENT);
    expect(forced.body.mode).toBe('fts');
  });
});
