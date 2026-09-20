/**
 * Phase 11 item 4 — users + JWT login + the single route policy map, with the demo tokens as a fallback.
 */
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { describeWithDb } from './helpers/db.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;
const PASSWORD = process.env.DEMO_USER_PASSWORD ?? 'trustdesk-demo';

describe('password hashing and JWT verification (no DB)', () => {
  it('scrypt hashes verify their own password and reject others or malformed strings', async () => {
    const { hashPassword, verifyPassword } = await import('../src/modules/auth/passwords.js');
    const h = hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(hashPassword('correct horse battery staple')).not.toBe(h); // random salt
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(verifyPassword('Correct horse battery staple', h)).toBe(false);
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$zz$')).toBe(false);
  });

  it('principalFromJwt accepts only unexpired tokens signed with the configured secret and issuer', async () => {
    const { principalFromJwt } = await import('../src/modules/auth/service.js');
    const { env } = await import('../src/config/env.js');
    const good = jwt.sign({ sub: 'usr_x', role: 'support_manager' }, env.JWT_SECRET, { issuer: 'trustdesk', expiresIn: 60 });
    expect(principalFromJwt(good)).toEqual({ userId: 'usr_x', role: 'support_manager' });
    expect(principalFromJwt(jwt.sign({ sub: 'usr_x', role: 'support_manager' }, 'another-secret-value-1234', { issuer: 'trustdesk', expiresIn: 60 }))).toBeNull();
    expect(principalFromJwt(jwt.sign({ sub: 'usr_x', role: 'support_manager' }, env.JWT_SECRET, { issuer: 'someone-else', expiresIn: 60 }))).toBeNull();
    expect(principalFromJwt(jwt.sign({ sub: 'usr_x', role: 'support_manager' }, env.JWT_SECRET, { issuer: 'trustdesk', expiresIn: -10 }))).toBeNull();
    expect(principalFromJwt(jwt.sign({ sub: 'usr_x', role: 'superuser' }, env.JWT_SECRET, { issuer: 'trustdesk', expiresIn: 60 }))).toBeNull();
    expect(principalFromJwt(jwt.sign({ role: 'admin' }, env.JWT_SECRET, { issuer: 'trustdesk', expiresIn: 60 }))).toBeNull();
    expect(principalFromJwt('agent-token-123')).toBeNull();
    expect(principalFromJwt(`${good}tampered`)).toBeNull();
  });

  it('the policy map matches routes by method and pattern, and leaves unlisted routes open to every role', async () => {
    const { policyFor, ROUTE_POLICIES } = await import('../src/middleware/policy.js');
    expect(policyFor('POST', '/api/eval-runs')?.roles).toEqual(['admin']);
    expect(policyFor('POST', '/api/eval-runs/')?.roles).toEqual(['admin']);
    expect(policyFor('GET', '/api/eval-runs')).toBeNull();
    expect(policyFor('POST', '/api/tool-actions/act_123/approve')?.roles).toEqual(['support_manager', 'admin']);
    expect(policyFor('POST', '/api/tool-actions/act_123/execute')).toBeNull();
    expect(policyFor('POST', '/api/tool-actions/a/b/approve')).toBeNull();
    expect(policyFor('post', '/api/documents/ingest')?.key).toBe('POST /api/documents/ingest');
    expect(policyFor('POST', '/api/EVAL-RUNS')?.roles).toEqual(['admin']); // Express routes case-insensitively by default
    expect(Object.keys(ROUTE_POLICIES)).toHaveLength(4);
  });
});

describeWithDb('login, JWT bearer auth and the policy middleware', () => {
  let app: Express;
  let prisma: (typeof import('../src/db/prisma.js'))['prisma'];

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    ({ prisma } = await import('../src/db/prisma.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function loginAs(email: string): Promise<{ token: string; user: { user_id: string; role: string } }> {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  it('the three seeded users log in, get a JWT with their role, and the token works on protected routes', async () => {
    for (const [email, userId, role] of [
      ['agent@trustdesk.local', 'usr_agent', 'support_agent'],
      ['manager@trustdesk.local', 'usr_manager', 'support_manager'],
      ['admin@trustdesk.local', 'usr_admin', 'admin'],
    ] as const) {
      const body = await loginAs(email);
      expect(body).toMatchObject({ token_type: 'Bearer', user: { user_id: userId, email, role } });
      expect(typeof body.token).toBe('string');
      expect(body.token.split('.')).toHaveLength(3);
      const decoded = jwt.decode(body.token) as { sub: string; role: string; iss: string; exp: number };
      expect(decoded).toMatchObject({ sub: userId, role, iss: 'trustdesk' });
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ user_id: userId, email, role });
      const tickets = await request(app).get('/api/tickets').set('Authorization', `Bearer ${body.token}`);
      expect(tickets.status).toBe(200);
    }
    // uppercase / padded email is normalised
    const padded = await request(app).post('/api/auth/login').send({ email: '  Agent@TrustDesk.local ', password: PASSWORD });
    expect(padded.status).toBe(200);
  });

  it('rejects a wrong password, an unknown email and a malformed body with the standard envelope', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: 'agent@trustdesk.local', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@trustdesk.local', password: PASSWORD });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message); // no account enumeration
    const bad = await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: PASSWORD });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a tampered or expired JWT is 401; the static demo tokens still work as a fallback', async () => {
    const { token } = await loginAs('manager@trustdesk.local');
    const tampered = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token.slice(0, -2)}xx`);
    expect(tampered.status).toBe(401);
    const { env } = await import('../src/config/env.js');
    const expired = jwt.sign({ sub: 'usr_manager', role: 'support_manager' }, env.JWT_SECRET, { issuer: 'trustdesk', expiresIn: -1 });
    const exp = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(exp.status).toBe(401);
    const demo = await request(app).get('/api/auth/me').set('Authorization', AGENT);
    expect(demo.status).toBe(200);
    expect(demo.body).toMatchObject({ user_id: 'usr_agent', role: 'support_agent', email: 'agent@trustdesk.local' });
  });

  it('the policy middleware enforces roles for JWT identities exactly like for demo tokens', async () => {
    const agent = await loginAs('agent@trustdesk.local');
    const manager = await loginAs('manager@trustdesk.local');
    const admin = await loginAs('admin@trustdesk.local');
    const forbidden = await request(app).post('/api/eval-runs').set('Authorization', `Bearer ${agent.token}`).send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.details).toMatchObject({ required_roles: ['admin'], route: 'POST /api/eval-runs' });
    const managerNo = await request(app).post('/api/documents/ingest').set('Authorization', `Bearer ${manager.token}`).send({});
    expect(managerNo.status).toBe(403);
    const managerYes = await request(app).post('/api/tool-actions/act_nope/approve').set('Authorization', `Bearer ${manager.token}`).send({ decision: 'approved', reason: 'policy test' });
    expect(managerYes.status).toBe(404); // passed the policy, the action does not exist
    const adminIngest = await request(app).post('/api/documents/ingest').set('Authorization', `Bearer ${admin.token}`).send({});
    expect(adminIngest.status).toBe(400); // passed the policy, empty body fails validation
    const agentOpen = await request(app).get('/api/eval-runs').set('Authorization', `Bearer ${agent.token}`);
    expect(agentOpen.status).toBe(200); // unlisted route: any role
    // path variants cannot dodge the policy (it matches case-insensitively, before routing): case, trailing slash, double slash
    for (const p of ['/api/EVAL-RUNS', '/api/eval-runs/', '/api//eval-runs', '/api/Eval-Runs/']) {
      const r = await request(app).post(p).set('Authorization', `Bearer ${agent.token}`).send({});
      expect(r.status, p).toBe(403);
    }
    // Express routes case-insensitively, so an allowed role reaches the handler through the odd-cased alias too (400 = validation)
    const aliased = await request(app).post('/api/documents/INGEST').set('Authorization', `Bearer ${admin.token}`).send({});
    expect(aliased.status).toBe(400);
  });
});
