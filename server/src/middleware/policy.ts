/**
 * Per-route role policy in ONE place (Phase 11 item 4). Routes not listed here are open to every
 * authenticated role; listed routes are restricted to the named roles. `enforcePolicy` is mounted
 * on the /api router right after requireAuth, so no router needs requireRole any more, and the
 * README's endpoint table / tests/auth.routes.test.ts read the same map.
 */
import type { NextFunction, Request, Response } from 'express';
import { forbiddenError, unauthorizedError } from '../errors/AppError.js';
import type { Role } from './auth.js';

export type RoutePattern = `${'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} /api/${string}`;

/** "METHOD /api/path/:param" -> roles allowed. Paths use the Express pattern of the route they guard. */
export const ROUTE_POLICIES: Readonly<Record<RoutePattern, readonly Role[]>> = Object.freeze({
  'POST /api/documents/ingest': ['admin'],
  'POST /api/documents/reingest': ['admin'],
  'POST /api/tool-actions/:actionId/approve': ['support_manager', 'admin'],
  'POST /api/eval-runs': ['admin'],
});

interface CompiledPolicy {
  key: RoutePattern;
  method: string;
  regex: RegExp;
  roles: readonly Role[];
}

// ":param" segments match one path segment; a trailing slash is tolerated. The match is
// case-insensitive because Express routing is case-insensitive by default (Router() instances do not
// inherit app-level settings), so /api/EVAL-RUNS reaches the same handler and must meet the same policy.
function compile(pattern: RoutePattern, roles: readonly Role[]): CompiledPolicy {
  const [method, path] = pattern.split(' ') as [string, string];
  const source = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { key: pattern, method, regex: new RegExp(`^${source}/?$`, 'i'), roles };
}

const COMPILED: CompiledPolicy[] = (Object.entries(ROUTE_POLICIES) as Array<[RoutePattern, readonly Role[]]>).map(([k, v]) => compile(k, v));

/** The policy entry that applies to a request (method + path under /api), or null when the route is open to all roles. */
export function policyFor(method: string, apiPath: string): CompiledPolicy | null {
  const m = method.toUpperCase();
  return COMPILED.find((p) => p.method === m && p.regex.test(apiPath)) ?? null;
}

/** Mounted on the /api router after requireAuth: `req.baseUrl` is "/api" and `req.path` the rest. */
export function enforcePolicy(req: Request, _res: Response, next: NextFunction): void {
  const policy = policyFor(req.method, `${req.baseUrl}${req.path}`);
  if (!policy) {
    next();
    return;
  }
  if (!req.principal) {
    next(unauthorizedError('Missing bearer token'));
    return;
  }
  if (!policy.roles.includes(req.principal.role)) {
    next(forbiddenError(`Role ${req.principal.role} may not perform this action`, { required_roles: [...policy.roles], route: policy.key }));
    return;
  }
  next();
}
