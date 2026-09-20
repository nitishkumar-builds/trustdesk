/**
 * Response-shape contract for the flows in docs/API_CONTRACT.md sections 2, 5, 6, 8, 9 and 11:
 * every documented field is present with the documented type, and every key the API itself
 * produces is snake_case at every level. Two keys are exempt from the recursive key check because
 * their contents are not produced by the server: `payload` (the client's own request body, stored
 * verbatim) and `details` (Zod issue objects on validation errors).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;
const MANAGER = `Bearer ${process.env.DEMO_MANAGER_TOKEN ?? 'manager-token-123'}`;
const RUN = Date.now().toString(36);

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/** Asserts every key at every level is snake_case, except under the listed opaque keys. */
function expectSnakeCase(value: unknown, opaque: string[] = [], trail = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectSnakeCase(v, opaque, `${trail}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      expect(k, `${trail}.${k} is not snake_case`).toMatch(SNAKE);
      if (!opaque.includes(k)) expectSnakeCase(v, opaque, `${trail}.${k}`);
    }
  }
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isRatio = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

describeWithDb('API contract: response shapes for docs/API_CONTRACT.md sections 2, 5, 6, 8, 9, 11', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  let evals: typeof import('../src/modules/evals/runner.js');
  const draftIds: string[] = [];
  const runIds: string[] = [];
  const actionIds: string[] = [];
  const evalRunIds: string[] = [];
  let tmpDir = '';

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    ({ prisma } = await import('../src/db/prisma.js'));
    evals = await import('../src/modules/evals/runner.js');
    const { createApp } = await import('../src/app.js');
    app = createApp();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trustdesk-contract-'));
  });

  afterAll(async () => {
    if (actionIds.length > 0) {
      await prisma.approval.deleteMany({ where: { actionId: { in: actionIds } } });
      await prisma.toolActionRequest.deleteMany({ where: { actionId: { in: actionIds } } });
      await prisma.agentRun.deleteMany({
        where: { runType: 'tool_recommendation', OR: actionIds.map((id) => ({ toolCalls: { array_contains: [{ action_id: id }] } })) },
      });
    }
    if (draftIds.length > 0) await prisma.draftReply.deleteMany({ where: { draftId: { in: draftIds } } });
    if (runIds.length > 0) {
      await prisma.triageResult.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { runId: { in: runIds } } });
    }
    if (evalRunIds.length > 0) await prisma.evalRun.deleteMany({ where: { evalRunId: { in: evalRunIds } } });
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('section 2: GET /api/documents/search returns { query, results[{ doc_id, title, snippet, score }] }', async () => {
    const res = await request(app).get('/api/documents/search').query({ q: 'damaged item replacement' }).set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expectSnakeCase(res.body);
    expect(res.body.query).toBe('damaged item replacement');
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const r of res.body.results) {
      expect(isString(r.doc_id)).toBe(true);
      expect(isString(r.title)).toBe(true);
      expect(typeof r.snippet).toBe('string');
      expect(typeof r.score).toBe('number');
      expect(r.doc_id).not.toBe('KB-ADVERSARIAL-001');
    }
    expect(res.body.results.map((r: { doc_id: string }) => r.doc_id)).toContain('KB-REFUND-001');
  });

  it('section 5: POST /api/tickets/:id/triage returns the documented fields with the documented types', async () => {
    const res = await request(app).post('/api/tickets/tkt_9001/triage').set('Authorization', AGENT);
    expect(res.status).toBe(200);
    runIds.push(res.body.run_id);
    expectSnakeCase(res.body);
    expect(res.body.ticket_id).toBe('tkt_9001');
    expect(isString(res.body.category)).toBe(true);
    expect(isString(res.body.priority)).toBe(true);
    expect(isString(res.body.sentiment)).toBe(true);
    expect(typeof res.body.should_escalate).toBe('boolean');
    expect(isString(res.body.reason_summary)).toBe(true);
    expect(res.body.run_id).toMatch(/^run_/);
    expect(['shipping', 'refund', 'warranty', 'billing', 'account_security', 'general']).toContain(res.body.category);
    expect(['low', 'medium', 'high', 'urgent']).toContain(res.body.priority);
  });

  it('section 6: POST /api/tickets/:id/draft-reply returns draft_id, ticket_id, status, body, citations, recommended_actions[], run_id', async () => {
    const res = await request(app).post('/api/tickets/tkt_9001/draft-reply').set('Authorization', AGENT);
    expect(res.status).toBe(200);
    draftIds.push(res.body.draft_id);
    runIds.push(res.body.run_id);
    expectSnakeCase(res.body);
    expect(res.body.draft_id).toMatch(/^draft_/);
    expect(res.body.ticket_id).toBe('tkt_9001');
    expect(res.body.status).toBe('generated');
    expect(isString(res.body.body)).toBe(true);
    expect(isStringArray(res.body.citations)).toBe(true);
    expect(res.body.citations.every((c: string) => /^KB-[A-Z]+-\d{3}$/.test(c))).toBe(true);
    expect(Array.isArray(res.body.recommended_actions)).toBe(true);
    for (const a of res.body.recommended_actions) {
      expect(isString(a.tool_name)).toBe(true);
      expect(typeof a.requires_human_approval).toBe('boolean');
      expect(isString(a.reason)).toBe(true);
    }
    expect(res.body.run_id).toMatch(/^run_/);
    // section 10 (trace): the stored guardrail results are API output too, so they are snake_case throughout
    const run = await request(app).get(`/api/agent-runs/${res.body.run_id}`).set('Authorization', AGENT);
    expect(run.status).toBe(200);
    expectSnakeCase(run.body);
    expect(run.body).toMatchObject({ run_id: res.body.run_id, ticket_id: 'tkt_9001', run_type: 'draft_reply', status: 'completed' });
    expect(isStringArray(run.body.retrieved_doc_ids)).toBe(true);
    expect(run.body.guardrail_results.decision.outcome).toBe('allow');
  });

  it('sections 8 and 9: request -> approval_required -> approve -> execute, idempotency key preserved throughout', async () => {
    const key = `tkt_9001-replacement-contract-${RUN}`;
    const body = { ticket_id: 'tkt_9001', tool_name: 'create_replacement_order', payload: { order_id: 'ord_5001', sku: 'BG-AIRPODS-01', reason: 'Damaged on arrival', idempotency_key: key } };

    // validation chain of section 8
    const unknownTool = await request(app).post('/api/tool-actions').set('Authorization', AGENT).send({ ...body, tool_name: 'delete_customer' });
    expect(unknownTool.status).toBe(404);
    expect(unknownTool.body.error.code).toBe('NOT_FOUND');
    const missingField = await request(app).post('/api/tool-actions').set('Authorization', AGENT).send({ ...body, payload: { order_id: 'ord_5001', idempotency_key: key } });
    expect(missingField.status).toBe(400);
    expect(missingField.body.error.code).toBe('VALIDATION_ERROR');
    const wrongCategory = await request(app).post('/api/tool-actions').set('Authorization', AGENT).send({ ...body, tool_name: 'lock_account', payload: { customer_id: 'cus_1001', reason: 'x', idempotency_key: key } });
    expect(wrongCategory.status).toBe(403);
    expect(wrongCategory.body.error.code).toBe('GUARDRAIL_BLOCKED');
    for (const e of [unknownTool, missingField, wrongCategory]) {
      expectSnakeCase(e.body, ['details']);
      expect(isString(e.body.error.message)).toBe(true);
      expect(isString(e.body.error.request_id)).toBe(true);
    }

    const created = await request(app).post('/api/tool-actions').set('Authorization', AGENT).send(body);
    expect(created.status).toBe(201);
    actionIds.push(created.body.action_id);
    expectSnakeCase(created.body, ['payload']);
    expect(created.body.action_id).toMatch(/^act_/);
    expect(created.body).toMatchObject({
      ticket_id: 'tkt_9001',
      tool_name: 'create_replacement_order',
      status: 'approval_required',
      requires_human_approval: true,
      idempotency_key: key,
      idempotent_replay: false,
      result: null,
      executed_at: null,
    });
    expect(created.body.payload).toMatchObject({ order_id: 'ord_5001', sku: 'BG-AIRPODS-01', idempotency_key: key });
    expect(isString(created.body.risk_level)).toBe(true);
    expect(isString(created.body.requested_by)).toBe(true);
    expect(isString(created.body.created_at)).toBe(true);
    expect(created.body.approvals).toEqual([]);

    // section 9: the human approval step, then execution with a stored result
    const approved = await request(app).post(`/api/tool-actions/${created.body.action_id}/approve`).set('Authorization', MANAGER).send({ decision: 'approved', reason: 'Contract test approval' });
    expect(approved.status).toBe(200);
    expectSnakeCase(approved.body, ['payload']);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.idempotency_key).toBe(key);
    expect(approved.body.approvals).toHaveLength(1);
    expect(approved.body.approvals[0]).toMatchObject({ decision: 'approved', reviewer_id: 'usr_manager', reason: 'Contract test approval', action_id: created.body.action_id });
    expect(approved.body.approvals[0].approval_id).toMatch(/^appr_/);

    const executed = await request(app).post(`/api/tool-actions/${created.body.action_id}/execute`).set('Authorization', AGENT);
    expect(executed.status).toBe(200);
    expectSnakeCase(executed.body, ['payload']);
    expect(executed.body.status).toBe('executed');
    expect(executed.body.idempotency_key).toBe(key);
    expect(executed.body.result).toMatchObject({ simulated: true });
    expect(isString(executed.body.executed_at)).toBe(true);

    const fetched = await request(app).get(`/api/tool-actions/${created.body.action_id}`).set('Authorization', AGENT);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ action_id: created.body.action_id, status: 'executed', idempotency_key: key });
    const replay = await request(app).post('/api/tool-actions').set('Authorization', AGENT).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ action_id: created.body.action_id, idempotent_replay: true });
  });

  it('section 11: GET /api/eval-runs/:id returns eval_run_id, total_cases and the four example metrics as ratios', async () => {
    const run = await evals.runEvals({ provider: 'mock', persist: true, outDir: tmpDir });
    evalRunIds.push(run.eval_run_id);
    for (const d of run.case_details) {
      draftIds.push(d.draft_id);
      runIds.push(d.triage_run_id, d.draft_run_id, d.eval_case_run_id);
    }
    const res = await request(app).get(`/api/eval-runs/${run.eval_run_id}`).set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expectSnakeCase(res.body);
    expect(res.body.eval_run_id).toBe(run.eval_run_id);
    expect(res.body.status).toBe('completed');
    expect(res.body.total_cases).toBe(8);
    for (const m of ['triage_accuracy', 'citation_coverage', 'unsafe_action_block_rate', 'escalation_accuracy']) {
      expect(isRatio(res.body[m]), m).toBe(true);
    }
    expect(Array.isArray(res.body.case_results)).toBe(true);
    expect(res.body.case_results).toHaveLength(8);
    for (const c of res.body.case_results) {
      expect(isString(c.case_id)).toBe(true);
      expect(isString(c.ticket_id)).toBe(true);
      expect(typeof c.passed).toBe('boolean');
      expect(isStringArray(c.citations)).toBe(true);
      expect(isStringArray(c.recommended_actions)).toBe(true);
      expect(isStringArray(c.blocked_actions)).toBe(true);
      expect(typeof c.should_escalate).toBe('boolean');
    }
    const list = await request(app).get('/api/eval-runs').set('Authorization', AGENT);
    expect(list.status).toBe(200);
    expectSnakeCase(list.body);
    expect(list.body.items.map((r: { eval_run_id: string }) => r.eval_run_id)).toContain(run.eval_run_id);
  }, 60_000);
});
