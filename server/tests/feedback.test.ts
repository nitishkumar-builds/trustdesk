/** Phase 11 item 2 — POST /api/feedback and GET /api/feedback?ticket_id= over the Phase 1 Feedback table. */
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;
const MANAGER = `Bearer ${process.env.DEMO_MANAGER_TOKEN ?? 'manager-token-123'}`;

describeWithDb('feedback API (AI_PROVIDER=mock)', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  const feedbackIds: string[] = [];
  const draftIds: string[] = [];
  const runIds: string[] = [];
  let draftId = '';
  const startedAt = new Date();

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    ({ prisma } = await import('../src/db/prisma.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
    const draft = await request(app).post('/api/tickets/tkt_9002/draft-reply').set('Authorization', AGENT);
    expect(draft.status).toBe(200);
    draftId = draft.body.draft_id;
    draftIds.push(draftId);
    runIds.push(draft.body.run_id);
    // only a triage this suite caused (the draft triages first when none exists) is cleaned up
    const triage = await prisma.triageResult.findFirst({ where: { ticketId: 'tkt_9002', createdAt: { gte: startedAt } }, orderBy: { createdAt: 'desc' } });
    if (triage) runIds.push(triage.runId);
  });

  afterAll(async () => {
    if (feedbackIds.length > 0) await prisma.feedback.deleteMany({ where: { feedbackId: { in: feedbackIds } } });
    if (draftIds.length > 0) await prisma.draftReply.deleteMany({ where: { draftId: { in: draftIds } } });
    if (runIds.length > 0) {
      await prisma.triageResult.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { runId: { in: runIds } } });
    }
    await prisma.$disconnect();
  });

  it('validates the body: rating 1-5, known ticket, draft of the same ticket', async () => {
    const tooLow = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_9002', rating: 0 });
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error.code).toBe('VALIDATION_ERROR');
    const tooHigh = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_9002', rating: 6 });
    expect(tooHigh.status).toBe(400);
    const fractional = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_9002', rating: 4.5 });
    expect(fractional.status).toBe(400);
    const noTicket = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_nope', rating: 3 });
    expect(noTicket.status).toBe(404);
    expect(noTicket.body.error.code).toBe('NOT_FOUND');
    const noDraft = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_9002', draft_id: 'draft_nope', rating: 3 });
    expect(noDraft.status).toBe(404);
    const wrongTicket = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_9001', draft_id: draftId, rating: 3 });
    expect(wrongTicket.status).toBe(400);
    expect(wrongTicket.body.error.details).toMatchObject({ field: 'draft_id', draft_ticket_id: 'tkt_9002' });
  });

  it('stores feedback (201) and lists it per ticket, newest first, with the average rating', async () => {
    const up = await request(app).post('/api/feedback').set('Authorization', AGENT).send({ ticket_id: 'tkt_9002', draft_id: draftId, rating: 5, reason: 'Clear and cites the shipping policy' });
    expect(up.status).toBe(201);
    feedbackIds.push(up.body.feedback_id);
    expect(up.body).toMatchObject({ ticket_id: 'tkt_9002', draft_id: draftId, rating: 5, reason: 'Clear and cites the shipping policy', corrected_response: null });
    expect(up.body.feedback_id).toMatch(/^fb_/);
    expect(typeof up.body.created_at).toBe('string');

    const down = await request(app).post('/api/feedback').set('Authorization', MANAGER).send({ ticket_id: 'tkt_9002', rating: 1, corrected_response: 'We have opened a carrier investigation and will update you within 2 business days.' });
    expect(down.status).toBe(201);
    feedbackIds.push(down.body.feedback_id);
    expect(down.body.draft_id).toBeNull();
    expect(down.body.corrected_response).toContain('carrier investigation');

    const list = await request(app).get('/api/feedback').query({ ticket_id: 'tkt_9002' }).set('Authorization', AGENT);
    expect(list.status).toBe(200);
    const ours = list.body.items.filter((f: { feedback_id: string }) => feedbackIds.includes(f.feedback_id));
    expect(ours.map((f: { feedback_id: string }) => f.feedback_id)).toEqual([down.body.feedback_id, up.body.feedback_id]);
    expect(list.body.total).toBeGreaterThanOrEqual(2);
    expect(typeof list.body.average_rating).toBe('number');

    const byDraft = await request(app).get('/api/feedback').query({ ticket_id: 'tkt_9002', draft_id: draftId }).set('Authorization', AGENT);
    expect(byDraft.body.items.map((f: { feedback_id: string }) => f.feedback_id)).toEqual([up.body.feedback_id]);
    expect(byDraft.body).toMatchObject({ total: 1, average_rating: 5 });

    const other = await request(app).get('/api/feedback').query({ ticket_id: 'tkt_9003' }).set('Authorization', AGENT);
    expect(other.body.items.filter((f: { feedback_id: string }) => feedbackIds.includes(f.feedback_id))).toHaveLength(0);
    const badLimit = await request(app).get('/api/feedback').query({ limit: 0 }).set('Authorization', AGENT);
    expect(badLimit.status).toBe(400);
  });
});
