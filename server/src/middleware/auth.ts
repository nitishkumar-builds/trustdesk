import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env } from '../config/env.js';
import { forbiddenError, unauthorizedError } from '../errors/AppError.js';
import { principalFromJwt } from '../modules/auth/service.js';

export type Role = 'support_agent' | 'support_manager' | 'admin';

export interface Principal {
  userId: string;
  role: Role;
}

// Static demo tokens -> principals (CLAUDE.md D-007). Rebuilt per call so tests can swap env.
function tokenTable(): ReadonlyMap<string, Principal> {
  return new Map<string, Principal>([
    [env.DEMO_AGENT_TOKEN, { userId: 'usr_agent', role: 'support_agent' }],
    [env.DEMO_MANAGER_TOKEN, { userId: 'usr_manager', role: 'support_manager' }],
    [env.DEMO_ADMIN_TOKEN, { userId: 'usr_admin', role: 'admin' }],
  ]);
}

// A demo token (static fallback, D-007) or a JWT issued by POST /api/auth/login (Phase 11 item 4).
export function resolveToken(token: string | undefined): Principal | null {
  if (!token) return null;
  return tokenTable().get(token) ?? principalFromJwt(token);
}

// Reads `Authorization: Bearer <token>`; unknown or missing -> 401 UNAUTHORIZED.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    next(unauthorizedError('Missing bearer token'));
    return;
  }
  const principal = resolveToken(token.trim());
  if (!principal) {
    next(unauthorizedError('Invalid bearer token'));
    return;
  }
  req.principal = principal;
  next();
}

// Allows only the listed roles. Must run after requireAuth. Since Phase 11 item 4 the per-route
// policies live in middleware/policy.ts (enforcePolicy); this helper is kept for ad-hoc use.
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.principal) {
      next(unauthorizedError('Missing bearer token'));
      return;
    }
    if (!roles.includes(req.principal.role)) {
      next(
        forbiddenError(`Role ${req.principal.role} may not perform this action`, {
          required_roles: roles,
        }),
      );
      return;
    }
    next();
  };
}

// For handlers mounted behind requireAuth; throws instead of returning undefined.
export function getPrincipal(req: Request): Principal {
  if (!req.principal) throw unauthorizedError('Missing bearer token');
  return req.principal;
}
