import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;
const MANAGER = `Bearer ${process.env.DEMO_MANAGER_TOKEN ?? 'manager-token-123'}`;
const ADMIN = `Bearer ${process.env.DEMO_ADMIN_TOKEN ?? 'admin-token-123'}`;

interface ActionBody {
  action_id: string;
  ticket_id: string;
  tool_name: string;
  status: string;
  requires_human_approval: boolean;
  idempotency_key: string;
  requested_by: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  executed_at: string | null;
  idempotent_replay: boolean;
  approvals: Array<{ decision: string; reviewer_id: string; reason: string }>;
}

// Unique per run so a re-run never collides with rows a crashed run left behind.
const RUN = `${Date.now().toString(36)}`;
const key = (s: string) => `${s}-${RUN}`;

describeWithDb('tool actions: approval gate and idempotency', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  const actionIds: string[] = [];
  const triageRunIds: string[] = [];
  let executedRefundId = '';
  const track = (a: ActionBody) => {
    if (!actionIds.includes(a.action_id)) actionIds.push(a.action_id);
    return a;
  };

  async function triage(ticketId: string) {
    const res = await request(app).post(`/api/tickets/${ticketId}/triage`).set('Authorization', AGENT);
    expect(res.status).toBe(200);
    triageRunIds.push(res.body.run_id);
    return res.body;
  }

  async function requestAction(ticketId: string, toolName: string, payload: Record<string, unknown>, auth = AGENT) {
    return request(app).post('/api/tool-actions').set('Authorization', auth).send({ ticket_id: ticketId, tool_name: toolName, payload });
  }

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    ({ prisma } = await import('../src/db/prisma.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
    // The mock adapter is deterministic, so a fresh triage per ticket makes the suite independent of leftovers.
    for (const t of ['tkt_9001', 'tkt_9002', 'tkt_9004', 'tkt_9006', 'tkt_9008']) await triage(t);
  });

  afterAll(async () => {
    // Safety net: any row keyed with this run's suffix that a failed assertion left untracked.
    const suffixed = await prisma.toolActionRequest.findMany({ where: { idempotencyKey: { endsWith: `-${RUN}` } }, select: { actionId: true } });
    const ids = [...new Set([...actionIds, ...suffixed.map((a) => a.actionId)])];
    if (ids.length > 0) {
      await prisma.approval.deleteMany({ where: { actionId: { in: ids } } });
      await prisma.toolActionRequest.deleteMany({ where: { actionId: { in: ids } } });
      // Every request (created or replayed) wrote a tool_recommendation run whose tool_calls[0].action_id is the action.
      await prisma.agentRun.deleteMany({
        where: { runType: 'tool_recommendation', OR: ids.map((id) => ({ toolCalls: { array_contains: [{ action_id: id }] } })) },
      });
    }
    if (triageRunIds.length > 0) {
      await prisma.triageResult.deleteMany({ where: { runId: { in: triageRunIds } } });
      await prisma.agentRun.deleteMany({ where: { runId: { in: triageRunIds } } });
    }
    await prisma.$disconnect();
  });

  it('happy path: request -> approval_required -> execute 409 -> agent approve 403 -> manager approve -> execute -> simulated result', async () => {
    const payload = { order_id: 'ord_5001', sku: 'BG-AIRPODS-01', reason: 'Damaged on arrival', idempotency_key: key('tkt_9001-replacement') };
    const created = await requestAction('tkt_9001', 'create_replacement_order', payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const a = track(created.body as ActionBody);
    expect(a).toMatchObject({ status: 'approval_required', requires_human_approval: true, idempotent_replay: false, requested_by: 'usr_agent', tool_name: 'create_replacement_order' });
    expect(a.action_id).toMatch(/^act_/);

    // A tool_recommendation trace references the action id.
    const runs = await prisma.agentRun.findMany({
      where: { ticketId: 'tkt_9001', runType: 'tool_recommendation', toolCalls: { array_contains: [{ action_id: a.action_id }] } },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'completed', modelProvider: 'none' });

    const tooEarly = await request(app).post(`/api/tool-actions/${a.action_id}/execute`).set('Authorization', AGENT);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('CONFLICT');
    expect(tooEarly.body.error.message).toContain('approval_required');

    const agentApprove = await request(app)
      .post(`/api/tool-actions/${a.action_id}/approve`)
      .set('Authorization', AGENT)
      .send({ decision: 'approved', reason: 'I approve myself' });
    expect(agentApprove.status).toBe(403);
    expect(agentApprove.body.error.code).toBe('FORBIDDEN');

    const shortReason = await request(app)
      .post(`/api/tool-actions/${a.action_id}/approve`)
      .set('Authorization', MANAGER)
      .send({ decision: 'approved', reason: 'ok' });
    expect(shortReason.status).toBe(400);

    const approved = await request(app)
      .post(`/api/tool-actions/${a.action_id}/approve`)
      .set('Authorization', MANAGER)
      .send({ decision: 'approved', reason: 'Damage confirmed by photo' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvals).toHaveLength(1);
    expect(approved.body.approvals[0]).toMatchObject({ decision: 'approved', reviewer_id: 'usr_manager', reason: 'Damage confirmed by photo' });

    const again = await request(app)
      .post(`/api/tool-actions/${a.action_id}/approve`)
      .set('Authorization', ADMIN)
      .send({ decision: 'approved', reason: 'second approval' });
    expect(again.status).toBe(409);

    const executed = await request(app).post(`/api/tool-actions/${a.action_id}/execute`).set('Authorization', AGENT);
    expect(executed.status).toBe(200);
    expect(executed.body.status).toBe('executed');
    expect(executed.body.idempotent_replay).toBe(false);
    expect(executed.body.result.simulated).toBe(true);
    expect(executed.body.result.replacement_order_id).toMatch(/^ord_r_[a-z0-9]{6}$/);
    expect(executed.body.result.original_order.order_id).toBe('ord_5001');
    expect(executed.body.executed_at).not.toBeNull();

    const detail = await request(app).get(`/api/tool-actions/${a.action_id}`).set('Authorization', AGENT);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ status: 'executed', approvals: [{ decision: 'approved' }] });
  });

  it('idempotency: same (tool, key) twice -> one row + idempotent_replay; execute twice -> executor runs once', async () => {
    const { getToolRegistry } = await import('../src/modules/toolActions/registry.js');
    const entry = (await getToolRegistry()).get('start_refund_review')!;
    const spy = vi.spyOn(entry, 'executor');
    try {
      const payload = { order_id: 'ord_5006', reason: 'Duplicate charge', amount: 15999, idempotency_key: key('tkt_9008-refund') };
      const first = await requestAction('tkt_9008', 'start_refund_review', payload);
      expect(first.status).toBe(201);
      const a = track(first.body as ActionBody);
      expect(a.idempotent_replay).toBe(false);

      const second = await requestAction('tkt_9008', 'start_refund_review', { ...payload, reason: 'retry with a different reason' });
      expect(second.status).toBe(200);
      expect(second.body.action_id).toBe(a.action_id);
      expect(second.body.idempotent_replay).toBe(true);
      expect(second.body.payload).toEqual(first.body.payload);
      expect(second.body.payload.reason).toBe('Duplicate charge');
      expect(await prisma.toolActionRequest.count({ where: { toolName: 'start_refund_review', idempotencyKey: payload.idempotency_key } })).toBe(1);
      expect(await prisma.agentRun.count({ where: { runType: 'tool_recommendation', toolCalls: { array_contains: [{ action_id: a.action_id }] } } })).toBe(2);

      // concurrent creates with a fresh key: exactly one row
      const raceKey = key('tkt_9008-refund-race');
      const [r1, r2] = await Promise.all([
        requestAction('tkt_9008', 'start_refund_review', { ...payload, idempotency_key: raceKey }),
        requestAction('tkt_9008', 'start_refund_review', { ...payload, idempotency_key: raceKey }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 201]);
      expect(r1.body.action_id).toBe(r2.body.action_id);
      expect(r1.body.payload).toEqual(r2.body.payload);
      track(r1.body as ActionBody);
      expect(await prisma.toolActionRequest.count({ where: { toolName: 'start_refund_review', idempotencyKey: raceKey } })).toBe(1);

      const approved = await request(app)
        .post(`/api/tool-actions/${a.action_id}/approve`)
        .set('Authorization', MANAGER)
        .send({ decision: 'approved', reason: 'One order on file, second charge is duplicate' });
      expect(approved.status).toBe(200);

      const e1 = await request(app).post(`/api/tool-actions/${a.action_id}/execute`).set('Authorization', AGENT);
      const e2 = await request(app).post(`/api/tool-actions/${a.action_id}/execute`).set('Authorization', AGENT);
      expect(e1.status).toBe(200);
      expect(e2.status).toBe(200);
      expect(e1.body.idempotent_replay).toBe(false);
      expect(e2.body.idempotent_replay).toBe(true);
      expect(e2.body.result).toEqual(e1.body.result);
      expect(e1.body.result.review_id).toMatch(/^rr_/);
      expect(spy).toHaveBeenCalledTimes(1);
      executedRefundId = a.action_id;

      // concurrent executes on a second approved action: executor still once
      const b = track((await requestAction('tkt_9008', 'start_refund_review', { ...payload, idempotency_key: key('tkt_9008-refund-2') })).body as ActionBody);
      await request(app).post(`/api/tool-actions/${b.action_id}/approve`).set('Authorization', MANAGER).send({ decision: 'approved', reason: 'Approved for race test' });
      spy.mockClear();
      const [x1, x2] = await Promise.all([
        request(app).post(`/api/tool-actions/${b.action_id}/execute`).set('Authorization', AGENT),
        request(app).post(`/api/tool-actions/${b.action_id}/execute`).set('Authorization', AGENT),
      ]);
      expect([x1.status, x2.status].every((s) => s === 200 || s === 409)).toBe(true);
      const winners = [x1, x2].filter((r) => r.status === 200 && r.body.idempotent_replay === false);
      expect(winners).toHaveLength(1);
      for (const r of [x1, x2]) {
        if (r.status === 409) expect(r.body.error.details.current_status).toBe('executing');
        else if (r.body.idempotent_replay) expect(r.body.result).toEqual(winners[0]!.body.result);
      }
      expect(spy).toHaveBeenCalledTimes(1);
      const final = await prisma.toolActionRequest.findUniqueOrThrow({ where: { actionId: b.action_id } });
      expect(final.status).toBe('executed');

      // Deterministic after-completion loser: its pre-claim read saw 'approved', the claim then finds the row executed.
      // vi.spyOn cannot restore a Prisma delegate method (the proxy regenerates them per access), so the
      // one-shot stale read is installed and removed by hand.
      const delegate = prisma.toolActionRequest as unknown as { findUnique: (args: unknown) => Promise<unknown> };
      const realFindUnique = delegate.findUnique;
      let staleReads = 1;
      delegate.findUnique = (args) => (staleReads-- > 0 ? Promise.resolve({ ...final, status: 'approved', approvals: [] }) : realFindUnique.call(delegate, args));
      try {
        const late = await request(app).post(`/api/tool-actions/${b.action_id}/execute`).set('Authorization', AGENT);
        expect(late.status, JSON.stringify(late.body)).toBe(200);
        expect(late.body.idempotent_replay).toBe(true);
        expect(late.body.status).toBe('executed');
        expect(late.body.result).toEqual(final.result);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        delegate.findUnique = realFindUnique;
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('category gate: create_replacement_order on tkt_9002 (shipping) -> 403 GUARDRAIL_BLOCKED', async () => {
    const res = await requestAction('tkt_9002', 'create_replacement_order', { order_id: 'ord_5002', sku: 'BG-CASE-14', reason: 'lost', idempotency_key: key('tkt_9002-repl') });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GUARDRAIL_BLOCKED');
    expect(res.body.error.message).toContain('shipping');
    expect(res.body.error.message).toContain('create_replacement_order');
    expect(res.body.error.details.rule).toBe('category_not_allowed');
    expect(await prisma.toolActionRequest.count({ where: { toolName: 'create_replacement_order', idempotencyKey: key('tkt_9002-repl') } })).toBe(0);
  });

  it('case gate: create_replacement_order on tkt_9004 (warranty, safety) -> 403 with the safety reason', async () => {
    const res = await requestAction('tkt_9004', 'create_replacement_order', { order_id: 'ord_5005', sku: 'BG-TAB-10', reason: 'swollen battery', idempotency_key: key('tkt_9004-repl') });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GUARDRAIL_BLOCKED');
    expect(res.body.error.details.rule).toBe('safety_escalation_first');
    expect(res.body.error.message.toLowerCase()).toContain('safety');
    expect(await prisma.toolActionRequest.count({ where: { toolName: 'create_replacement_order', idempotencyKey: key('tkt_9004-repl') } })).toBe(0);

    // escalation itself is allowed on the same ticket and executes immediately (low risk)
    const esc = await requestAction('tkt_9004', 'escalate_to_human', { ticket_id: 'tkt_9004', reason: 'Battery swelling', queue: 'safety', idempotency_key: key('tkt_9004-esc') });
    expect(esc.status).toBe(201);
    track(esc.body as ActionBody);
    expect(esc.body).toMatchObject({ status: 'executed', requires_human_approval: false });
    expect(esc.body.result).toMatchObject({ simulated: true, queue: 'safety' });
  });

  it('coupon cap: 5000 on tkt_9006 -> 403; 500 requires approval and never auto-executes', async () => {
    const big = await requestAction('tkt_9006', 'issue_coupon', { customer_id: 'cus_1006', amount: 5000, reason: 'goodwill', idempotency_key: key('tkt_9006-coupon-5000') });
    expect(big.status).toBe(403);
    expect(big.body.error.code).toBe('GUARDRAIL_BLOCKED');
    expect(big.body.error.details.reason).toBe('coupon_amount_exceeds_limit');
    expect(await prisma.toolActionRequest.count({ where: { toolName: 'issue_coupon', idempotencyKey: key('tkt_9006-coupon-5000') } })).toBe(0);

    const small = await requestAction('tkt_9006', 'issue_coupon', { customer_id: 'cus_1006', amount: 500, reason: 'goodwill', idempotency_key: key('tkt_9006-coupon-500') });
    expect(small.status).toBe(201);
    const a = track(small.body as ActionBody);
    expect(a.status).toBe('approval_required');
    expect(a.executed_at).toBeNull();
    const exec = await request(app).post(`/api/tool-actions/${a.action_id}/execute`).set('Authorization', AGENT);
    expect(exec.status).toBe(409);
    expect((await prisma.toolActionRequest.findUniqueOrThrow({ where: { actionId: a.action_id } })).status).toBe('approval_required');
  });

  it('missing required field -> 400 listing the field; bad references -> 400', async () => {
    const res = await requestAction('tkt_9001', 'create_replacement_order', { order_id: 'ord_5001', reason: 'x', idempotency_key: key('tkt_9001-missing') });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('sku');
    expect(res.body.error.details.missing_fields).toEqual(['sku']);
    expect(await prisma.toolActionRequest.count({ where: { toolName: 'create_replacement_order', idempotencyKey: key('tkt_9001-missing') } })).toBe(0);

    const wrongOrder = await requestAction('tkt_9001', 'create_replacement_order', { order_id: 'ord_5006', sku: 'x', reason: 'x', idempotency_key: key('tkt_9001-wrong-order') });
    expect(wrongOrder.status).toBe(400);
    expect(wrongOrder.body.error.details.field).toBe('order_id');

    const badAmount = await requestAction('tkt_9008', 'start_refund_review', { order_id: 'ord_5006', reason: 'x', amount: 'lots', idempotency_key: key('tkt_9008-bad-amount') });
    expect(badAmount.status).toBe(400);
    expect(badAmount.body.error.code).toBe('VALIDATION_ERROR');
    expect(badAmount.body.error.details.invalid_fields.join(' ')).toContain('amount');

    const unknownTool = await requestAction('tkt_9001', 'delete_everything', { idempotency_key: key('x') });
    expect(unknownTool.status).toBe(404);
    expect(unknownTool.body.error.code).toBe('NOT_FOUND');
    expect(unknownTool.body.error.message).toContain('delete_everything');
    const unknownTicket = await requestAction('tkt_nope', 'escalate_to_human', { ticket_id: 'tkt_nope', reason: 'x', queue: 'q', idempotency_key: key('y') });
    expect(unknownTicket.status).toBe(404);
    expect(unknownTicket.body.error.code).toBe('NOT_FOUND');
    expect(unknownTicket.body.error.message).toContain('tkt_nope');
  });

  it('a ticket with no triage is triaged first (step 3) before the category gate runs', async () => {
    const before = new Date();
    // Only this suite's own triage of tkt_9004 (from beforeAll) is removed, so no foreign trace is orphaned.
    await prisma.triageResult.deleteMany({ where: { ticketId: 'tkt_9004', runId: { in: triageRunIds } } });
    const remaining = await prisma.triageResult.count({ where: { ticketId: 'tkt_9004' } });
    if (remaining > 0) return; // a dev DB with older triages: the auto-triage path is covered on a fresh seed (test:ci)
    const res = await requestAction('tkt_9004', 'escalate_to_human', { ticket_id: 'tkt_9004', reason: 'Battery swelling, no triage on file', queue: 'safety', idempotency_key: key('tkt_9004-esc-untriaged') });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    track(res.body as ActionBody);
    expect(res.body.status).toBe('executed');
    const triages = await prisma.triageResult.findMany({ where: { ticketId: 'tkt_9004', createdAt: { gte: before } } });
    expect(triages).toHaveLength(1);
    expect(triages[0]).toMatchObject({ category: 'warranty', shouldEscalate: true });
    triageRunIds.push(triages[0]!.runId);
  });

  it('start_refund_review on tkt_9008 (billing) -> allowed and approval-gated; rejection blocks execution', async () => {
    const res = await requestAction('tkt_9008', 'start_refund_review', { order_id: 'ord_5006', reason: 'Duplicate charge', amount: 15999, idempotency_key: key('tkt_9008-refund-reject') });
    expect(res.status).toBe(201);
    const a = track(res.body as ActionBody);
    expect(a).toMatchObject({ status: 'approval_required', requires_human_approval: true });

    const rejected = await request(app)
      .post(`/api/tool-actions/${a.action_id}/approve`)
      .set('Authorization', ADMIN)
      .send({ decision: 'rejected', reason: 'Charge already reversed by the bank' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.approvals[0]).toMatchObject({ decision: 'rejected', reviewer_id: 'usr_admin' });

    const exec = await request(app).post(`/api/tool-actions/${a.action_id}/execute`).set('Authorization', AGENT);
    expect(exec.status).toBe(409);
    expect(exec.body.error.message).toContain('rejected');
  });

  it('list and detail endpoints, catalog, and the ticket detail include the actions', async () => {
    const list = await request(app).get('/api/tool-actions').query({ ticket_id: 'tkt_9008', status: 'executed' }).set('Authorization', AGENT);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(1);
    expect(list.body.items.every((a: ActionBody) => a.ticket_id === 'tkt_9008' && a.status === 'executed')).toBe(true);
    expect(list.body.items.map((a: ActionBody) => a.action_id)).toContain(executedRefundId);
    expect(list.body.total).toBe(list.body.items.length);

    const byTool = await request(app).get('/api/tool-actions').query({ tool_name: 'start_refund_review', limit: 200 }).set('Authorization', AGENT);
    expect(byTool.status).toBe(200);
    expect(byTool.body.items.every((a: ActionBody) => a.tool_name === 'start_refund_review')).toBe(true);
    expect(byTool.body.items.map((a: ActionBody) => a.action_id)).toContain(executedRefundId);

    const catalog = await request(app).get('/api/tool-actions/catalog').set('Authorization', AGENT);
    expect(catalog.status).toBe(200);
    expect(catalog.body.items.map((t: { tool_name: string }) => t.tool_name).sort()).toEqual(
      ['create_replacement_order', 'escalate_to_human', 'issue_coupon', 'lock_account', 'open_carrier_investigation', 'start_refund_review'],
    );

    const detail = await request(app).get('/api/tickets/tkt_9008').set('Authorization', AGENT);
    expect(detail.body.tool_action_requests.length).toBeGreaterThanOrEqual(1);

    const missing = await request(app).get('/api/tool-actions/act_nope').set('Authorization', AGENT);
    expect(missing.status).toBe(404);
    const noAuth = await request(app).post('/api/tool-actions').send({});
    expect(noAuth.status).toBe(401);
  });
});
