/**
 * Every route except GET /health and POST /api/auth/login requires a bearer token. Checked two ways:
 *   1. structurally — the Express router stack is enumerated and each non-health route must sit
 *      behind the requireAuth layer;
 *   2. behaviourally — every enumerated route answers 401 UNAUTHORIZED to a request without a
 *      token and to one with an unknown token (auth runs before validation, so no DB is needed).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { listRoutes, type RegisteredRoute } from './helpers/routes.js';

const AGENT = `Bearer ${process.env.DEMO_AGENT_TOKEN ?? 'agent-token-123'}`;
const MANAGER = `Bearer ${process.env.DEMO_MANAGER_TOKEN ?? 'manager-token-123'}`;
const ADMIN = `Bearer ${process.env.DEMO_ADMIN_TOKEN ?? 'admin-token-123'}`;
const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../README.md');

// Routes that need no token at all.
const OPEN_ROUTES = ['GET /health', 'POST /api/auth/login'];
// Which roles each guarded route accepts: the single policy map (middleware/policy.ts, Phase 11 item 4).
let GUARDED: Record<string, string[]> = {};

describe('auth: every route except /health requires a bearer token', () => {
  let app: Express;
  let routes: RegisteredRoute[];

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    const { createApp } = await import('../src/app.js');
    const { requireAuth } = await import('../src/middleware/auth.js');
    const { ROUTE_POLICIES } = await import('../src/middleware/policy.js');
    GUARDED = Object.fromEntries(Object.entries(ROUTE_POLICIES).map(([k, v]) => [k, [...v]]));
    app = createApp();
    routes = listRoutes(app, requireAuth);
  });

  it('enumerates the real router stack (sanity: the documented endpoints are present)', () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET /health',
        'GET /api/tickets',
        'GET /api/tickets/:ticketId',
        'POST /api/tickets/:ticketId/triage',
        'POST /api/tickets/:ticketId/draft-reply',
        'PATCH /api/drafts/:draftId',
        'POST /api/tool-actions',
        'POST /api/tool-actions/:actionId/approve',
        'POST /api/tool-actions/:actionId/execute',
        'GET /api/agent-runs/:runId',
        'POST /api/eval-runs',
        'GET /api/eval-runs/:evalRunId',
        'GET /api/documents/search',
      ]),
    );
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });

  it('structurally: GET /health and POST /api/auth/login are the only routes outside requireAuth', () => {
    const open = routes.filter((r) => !r.authenticated);
    expect(open.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...OPEN_ROUTES].sort());
    for (const r of routes.filter((r) => !OPEN_ROUTES.includes(`${r.method} ${r.path}`))) {
      expect(r.path.startsWith('/api/'), `${r.method} ${r.path} is mounted outside /api`).toBe(true);
      expect(r.authenticated, `${r.method} ${r.path} is not behind requireAuth`).toBe(true);
    }
  });

  it('structurally: role policies live in one map whose keys are real routes, and no router carries its own role guard', () => {
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const policyKey of Object.keys(GUARDED)) expect(keys.has(policyKey), `policy for unknown route ${policyKey}`).toBe(true);
    expect(Object.keys(GUARDED).sort()).toEqual(['POST /api/documents/ingest', 'POST /api/documents/reingest', 'POST /api/eval-runs', 'POST /api/tool-actions/:actionId/approve'].sort());
    expect(routes.filter((r) => r.guards.length > 0)).toEqual([]);
  });

  it('behaviourally: the guarded routes answer 403 FORBIDDEN naming the required roles, and pass the allowed roles through', async () => {
    const tokens: Record<string, string> = { support_agent: AGENT, support_manager: MANAGER, admin: ADMIN };
    for (const [key, allowed] of Object.entries(GUARDED)) {
      const [method, rawPath] = key.split(' ') as [string, string];
      const p = rawPath.replace(/:[A-Za-z]+/g, 'x');
      for (const [role, token] of Object.entries(tokens)) {
        // An allowed role reaches the handler: an empty body fails Zod validation (400) before any DB
        // or side effect; the admin-only routes with side effects (reingest, eval-runs) are only probed
        // with the roles that must be rejected.
        if (allowed.includes(role)) {
          if (key === 'POST /api/documents/reingest' || key === 'POST /api/eval-runs') continue;
          const ok = await request(app).post(p).set('Authorization', token).send({});
          expect(ok.status, `${key} as ${role}`).toBe(400);
          expect(ok.body.error.code).toBe('VALIDATION_ERROR');
        } else {
          const res = await request(app)[method.toLowerCase() as 'post'](p).set('Authorization', token).send({});
          expect(res.status, `${key} as ${role}`).toBe(403);
          expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required_roles: allowed } });
          // Express routes case-insensitively: an upper-cased last segment must meet the same policy
          const shouted = p.replace(/[^/]+$/, (seg) => seg.toUpperCase());
          const alias = await request(app)[method.toLowerCase() as 'post'](shouted).set('Authorization', token).send({});
          expect(alias.status, `${shouted} as ${role}`).toBe(403);
        }
      }
    }
  });

  it('the README endpoint table lists exactly the registered routes, with the guarded roles', async () => {
    const readme = await fs.readFile(README, 'utf8');
    const rows = readme
      .split('\n')
      .map((line) => /^\| (GET|POST|PATCH|PUT|DELETE) \| `([^`]+)` \| ([^|]+) \|/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ key: `${m[1]} ${m[2]}`, role: m[3]!.trim() }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.key).sort()).toEqual(routes.map((r) => `${r.method} ${r.path}`).sort());
    for (const row of rows) {
      const allowed = GUARDED[row.key];
      expect(row.role, row.key).toBe(allowed ? allowed.join(', ') : OPEN_ROUTES.includes(row.key) ? 'none' : 'any');
    }
  });

  it('behaviourally: every non-health route answers 401 with the error envelope when the token is missing or unknown', async () => {
    for (const r of routes.filter((r) => !OPEN_ROUTES.includes(`${r.method} ${r.path}`))) {
      const path = r.path.replace(/:[A-Za-z]+/g, 'x');
      const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const missing = await request(app)[method](path).send({});
      expect(missing.status, `${r.method} ${path} without a token`).toBe(401);
      expect(missing.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(typeof missing.body.error.request_id).toBe('string');
      const unknown = await request(app)[method](path).set('Authorization', 'Bearer not-a-real-token').send({});
      expect(unknown.status, `${r.method} ${path} with an unknown token`).toBe(401);
      expect(unknown.body.error.code).toBe('UNAUTHORIZED');
    }
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    // the open login route is reachable without a token (an empty body is a validation error, not 401)
    const login = await request(app).post('/api/auth/login').send({});
    expect(login.status).toBe(400);
    expect(login.body.error.code).toBe('VALIDATION_ERROR');
  });
});
