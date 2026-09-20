import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;
const SEED_TICKET_COUNT = 8;

describeWithDb('tickets / customers / orders API', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];
  const createdTicketIds: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import('../src/db/prisma.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
  });

  afterAll(async () => {
    if (createdTicketIds.length > 0) {
      await prisma.ticket.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    }
    await prisma.$disconnect();
  });

  it('GET /health needs no token', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: '0.1.0' });
  });

  it('401 without a token, in the standard envelope', async () => {
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHORIZED', details: null });
    expect(typeof res.body.error.request_id).toBe('string');
  });

  it('401 with a bad token', async () => {
    const res = await request(app).get('/api/tickets').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('200 with the agent token', async () => {
    const res = await request(app).get('/api/tickets').set('Authorization', AGENT);
    expect(res.status).toBe(200);
  });

  it('GET /api/tickets returns the 8 seed tickets and never a string containing "expected_"', async () => {
    const res = await request(app)
      .get('/api/tickets')
      .query({ pageSize: 100 })
      .set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(SEED_TICKET_COUNT);
    expect(res.body.items).toHaveLength(SEED_TICKET_COUNT);
    expect(res.body).toMatchObject({ page: 1, page_size: 100 });
    expect(JSON.stringify(res.body)).not.toContain('expected_');

    const first = res.body.items[0];
    expect(first).toMatchObject({
      ticket_id: 'tkt_9003',
      customer: { customer_id: 'cus_1004', name: 'Vikram Sethi', tier: 'standard' },
    });
    expect(first).toHaveProperty('latest_triage');
  });

  it('GET /api/tickets paginates', async () => {
    const res = await request(app)
      .get('/api/tickets')
      .query({ page: 2, pageSize: 3 })
      .set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.total).toBe(SEED_TICKET_COUNT);
  });

  it('GET /api/tickets rejects pageSize over 100 with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .get('/api/tickets')
      .query({ pageSize: 101 })
      .set('Authorization', AGENT);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/tickets/tkt_9001 has customer, order, and an open return window (as of created_at)', async () => {
    const res = await request(app).get('/api/tickets/tkt_9001').set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.customer.customer_id).toBe('cus_1001');
    expect(res.body.order.order_id).toBe('ord_5001');
    expect(res.body.policy_context.as_of).toBe('2026-06-28T04:45:00.000Z');
    expect(res.body.policy_context.return_window.eligible).toBe(true);
    expect(res.body.policy_context.warranty).toMatchObject({ covered: true, extension_applied: true });
    expect(Array.isArray(res.body.drafts)).toBe(true);
    expect(Array.isArray(res.body.tool_action_requests)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('expected_');
  });

  it('GET /api/tickets/tkt_9003 is final_sale and not eligible', async () => {
    const res = await request(app).get('/api/tickets/tkt_9003').set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.policy_context.return_window).toMatchObject({
      eligible: false,
      reason: 'final_sale',
    });
  });

  it('GET /api/tickets/:id 404s for an unknown ticket', async () => {
    const res = await request(app).get('/api/tickets/tkt_nope').set('Authorization', AGENT);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/tickets creates a ticket and fetches back the exact body text', async () => {
    const body = '  Hello,\n\nmy   order is late!!  \n\t<b>not html</b>  ';
    const create = await request(app)
      .post('/api/tickets')
      .set('Authorization', AGENT)
      .send({
        customer_id: 'cus_1002',
        order_id: 'ord_5002',
        channel: 'web',
        subject: 'Test ticket',
        body,
      });
    expect(create.status).toBe(201);
    expect(create.body.ticket_id).toMatch(/^tkt_[A-Za-z0-9]{8}$/);
    createdTicketIds.push(create.body.ticket_id);

    const fetched = await request(app)
      .get(`/api/tickets/${create.body.ticket_id}`)
      .set('Authorization', AGENT);
    expect(fetched.status).toBe(200);
    expect(fetched.body.body).toBe(body);
    expect(fetched.body.status).toBe('open');
    expect(fetched.body.order.order_id).toBe('ord_5002');
    expect(fetched.body.policy_context.return_window.reason).toBe('not_delivered');
  });

  it('POST /api/tickets 404s for an unknown customer or order, 400 for a bad channel', async () => {
    const base = { channel: 'email', subject: 's', body: 'b' };
    const c = await request(app)
      .post('/api/tickets')
      .set('Authorization', AGENT)
      .send({ ...base, customer_id: 'cus_0000' });
    expect(c.status).toBe(404);

    const o = await request(app)
      .post('/api/tickets')
      .set('Authorization', AGENT)
      .send({ ...base, customer_id: 'cus_1001', order_id: 'ord_0000' });
    expect(o.status).toBe(404);

    const ch = await request(app)
      .post('/api/tickets')
      .set('Authorization', AGENT)
      .send({ ...base, customer_id: 'cus_1001', channel: 'fax' });
    expect(ch.status).toBe(400);
    expect(ch.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/customers and /api/customers/:id (with orders)', async () => {
    const list = await request(app).get('/api/customers').set('Authorization', AGENT);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(6);

    const one = await request(app).get('/api/customers/cus_1001').set('Authorization', AGENT);
    expect(one.status).toBe(200);
    expect(one.body.customer_id).toBe('cus_1001');
    expect(one.body.orders.map((o: { order_id: string }) => o.order_id)).toEqual(['ord_5001']);
  });

  it('GET /api/orders/:id (with customer and tickets)', async () => {
    const res = await request(app).get('/api/orders/ord_5001').set('Authorization', AGENT);
    expect(res.status).toBe(200);
    expect(res.body.customer.customer_id).toBe('cus_1001');
    const ticketIds = res.body.tickets.map((t: { ticket_id: string }) => t.ticket_id);
    expect(ticketIds).toEqual(expect.arrayContaining(['tkt_9001', 'tkt_9007']));
    expect(JSON.stringify(res.body)).not.toContain('expected_');
  });
});
