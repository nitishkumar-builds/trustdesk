import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;

// Expected values from the prompt (the test ALSO reads TicketExpectation — the only place R2 allows it).
const PROMPT_EXPECTATIONS: Record<string, { category: string; priority: string }> = {
  tkt_9001: { category: 'refund', priority: 'medium' },
  tkt_9002: { category: 'shipping', priority: 'high' },
  tkt_9003: { category: 'refund', priority: 'low' },
  tkt_9004: { category: 'warranty', priority: 'urgent' },
  tkt_9005: { category: 'account_security', priority: 'high' },
  tkt_9006: { category: 'general', priority: 'medium' },
  tkt_9007: { category: 'account_security', priority: 'high' },
  tkt_9008: { category: 'billing', priority: 'high' },
};

describeWithDb('triage (AI_PROVIDER=mock)', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  const runIds: string[] = [];

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    ({ prisma } = await import('../src/db/prisma.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
  });

  afterAll(async () => {
    // Keep the seeded DB clean for other suites: remove what this suite produced.
    if (runIds.length > 0) {
      await prisma.triageResult.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { runId: { in: runIds } } });
    }
    await prisma.$disconnect();
  });

  it.each(Object.keys(PROMPT_EXPECTATIONS))(
    '%s triages to the expected category, priority and escalation and writes exactly one AgentRun',
    async (ticketId) => {
      const expectation = await prisma.ticketExpectation.findUniqueOrThrow({ where: { ticketId } });
      const runsBefore = await prisma.agentRun.count({ where: { ticketId, runType: 'triage' } });

      const res = await request(app).post(`/api/tickets/${ticketId}/triage`).set('Authorization', AGENT);
      expect(res.status).toBe(200);
      runIds.push(res.body.run_id);

      expect(res.body.ticket_id).toBe(ticketId);
      expect(res.body.category).toBe(PROMPT_EXPECTATIONS[ticketId]!.category);
      expect(res.body.priority).toBe(PROMPT_EXPECTATIONS[ticketId]!.priority);
      expect(res.body.category).toBe(expectation.expectedCategory);
      expect(res.body.priority).toBe(expectation.expectedPriority);
      expect(res.body.should_escalate).toBe(expectation.expectedEscalation);
      expect(res.body.sentiment).toBe(expectation.expectedSentiment);
      expect(typeof res.body.reason_summary).toBe('string');
      expect(Array.isArray(res.body.fired_rules)).toBe(true);
      expect(res.body.run_id).toMatch(/^run_/);

      const runsAfter = await prisma.agentRun.count({ where: { ticketId, runType: 'triage' } });
      expect(runsAfter - runsBefore).toBe(1);

      const run = await prisma.agentRun.findUniqueOrThrow({ where: { runId: res.body.run_id } });
      expect(run).toMatchObject({
        runType: 'triage',
        status: 'completed',
        modelProvider: 'mock',
        modelName: 'mock-rules-v1',
        promptVersion: 'triage.v1',
      });
      expect(run.retrievedDocIds.length).toBeGreaterThan(0);
      expect(run.retrievedDocIds).not.toContain('KB-ADVERSARIAL-001');
      expect(typeof run.latencyMs).toBe('number');
      expect(JSON.stringify(run.guardrailResults)).not.toContain('expected_');
    },
  );

  it('post-rules fire deterministically on the security tickets', async () => {
    const r4 = await request(app).post('/api/tickets/tkt_9004/triage').set('Authorization', AGENT);
    runIds.push(r4.body.run_id);
    expect(r4.body.fired_rules.map((f: { rule: string }) => f.rule)).toContain('PR1_safety');

    const r5 = await request(app).post('/api/tickets/tkt_9005/triage').set('Authorization', AGENT);
    runIds.push(r5.body.run_id);
    const r5rules = r5.body.fired_rules as Array<{ rule: string; matched_terms: string[]; applied: boolean }>;
    const pr2 = r5rules.find((f) => f.rule === 'PR2_account_change_or_identity_bypass');
    expect(pr2?.applied).toBe(true);
    expect(pr2?.matched_terms).toEqual(expect.arrayContaining(['change my account email', 'ignore identity']));

    const r7 = await request(app).post('/api/tickets/tkt_9007/triage').set('Authorization', AGENT);
    runIds.push(r7.body.run_id);
    expect(r7.body.fired_rules.map((f: { rule: string }) => f.rule)).toContain('PR3_secret_exfiltration');

    const r6 = await request(app).post('/api/tickets/tkt_9006/triage').set('Authorization', AGENT);
    runIds.push(r6.body.run_id);
    expect(r6.body.fired_rules.map((f: { rule: string }) => f.rule)).toContain('PR4_prompt_injection');

    const r2 = await request(app).post('/api/tickets/tkt_9002/triage').set('Authorization', AGENT);
    runIds.push(r2.body.run_id);
    expect(r2.body.fired_rules.map((f: { rule: string }) => f.rule)).toContain('PR5_shipping_urgency');

    const r8 = await request(app).post('/api/tickets/tkt_9008/triage').set('Authorization', AGENT);
    runIds.push(r8.body.run_id);
    expect(r8.body.fired_rules.map((f: { rule: string }) => f.rule)).toContain('PR6_billing_funds_impact');
  });

  it('post-rules override a wrong model answer (safety wins regardless of model mood)', async () => {
    const { applyPostRules } = await import('../src/modules/triage/postRules.js');
    const { result, fired } = applyPostRules('My tablet battery is swelling', {
      category: 'general',
      priority: 'low',
      sentiment: 'positive',
      should_escalate: false,
      reason_summary: 'looks fine',
    });
    expect(result).toMatchObject({ category: 'warranty', priority: 'urgent', should_escalate: true });
    expect(fired[0]).toMatchObject({ rule: 'PR1_safety', applied: true, matched_terms: ['swelling'] });
  });

  it('rule R7: a provider failure still writes a failed triage AgentRun before the error surfaces', async () => {
    const { triageTicket } = await import('../src/modules/triage/service.js');
    const { aiProviderError } = await import('../src/errors/AppError.js');
    const failing = { name: 'openrouter' as const, complete: async () => { throw aiProviderError('simulated outage'); } };
    const before = new Date();
    await expect(triageTicket('tkt_9001', { userId: 'usr_agent', role: 'support_agent' }, { adapter: failing })).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
    const failed = await prisma.agentRun.findMany({ where: { ticketId: 'tkt_9001', runType: 'triage', status: 'failed', createdAt: { gte: before } } });
    expect(failed).toHaveLength(1);
    runIds.push(failed[0]!.runId);
    expect(failed[0]!.modelProvider).toBe('openrouter');
    expect((failed[0]!.guardrailResults as { notes: string[] }).notes.join(' ')).toContain('provider_error: AI_PROVIDER_ERROR');
    const results = await prisma.triageResult.findMany({ where: { runId: failed[0]!.runId } });
    expect(results).toHaveLength(0);
  });

  it('GET /api/tickets/:id shows the latest triage and GET /api/agent-runs lists newest first', async () => {
    const t = await request(app).post('/api/tickets/tkt_9001/triage').set('Authorization', AGENT);
    runIds.push(t.body.run_id);

    const detail = await request(app).get('/api/tickets/tkt_9001').set('Authorization', AGENT);
    expect(detail.body.latest_triage).toMatchObject({ category: 'refund', priority: 'medium', run_id: t.body.run_id });

    const list = await request(app)
      .get('/api/agent-runs')
      .query({ ticket_id: 'tkt_9001', run_type: 'triage', limit: 5 })
      .set('Authorization', AGENT);
    expect(list.status).toBe(200);
    expect(list.body.items[0].run_id).toBe(t.body.run_id);

    const one = await request(app).get(`/api/agent-runs/${t.body.run_id}`).set('Authorization', AGENT);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ run_id: t.body.run_id, run_type: 'triage', ticket_id: 'tkt_9001' });
    expect(one.body.guardrail_results.fired_rules).toBeDefined();

    const missing = await request(app).get('/api/agent-runs/run_nope').set('Authorization', AGENT);
    expect(missing.status).toBe(404);
  });

  it('404 for an unknown ticket and 401 without a token', async () => {
    const nf = await request(app).post('/api/tickets/tkt_nope/triage').set('Authorization', AGENT);
    expect(nf.status).toBe(404);
    const un = await request(app).post('/api/tickets/tkt_9001/triage');
    expect(un.status).toBe(401);
  });
});
