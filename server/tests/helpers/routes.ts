// Enumerates the routes an Express 4 app actually registered by walking its router stack.
// Used by tests/auth.routes.test.ts, which asserts that every non-health route sits behind requireAuth
// and that the README's endpoint table matches this list exactly, so the documented API is the real one.
import type { Express, RequestHandler } from 'express';

export interface RegisteredRoute {
  method: string;
  path: string;
  /** True when a `requireAuth` layer precedes the route inside its mount chain. */
  authenticated: boolean;
  /** Names of the route-level handlers before the final one (e.g. requireRole guards). */
  guards: string[];
}

interface Layer {
  name: string;
  regexp: RegExp;
  handle: RequestHandler & { stack?: Layer[] };
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string; handle: RequestHandler }> };
}

// app.use('/api', router) stores /^\/api\/?(?=\/|$)/i; a path-less use() stores /^\/?(?=\/|$)/i.
function mountPath(layer: Layer): string {
  const src = layer.regexp.source;
  if (src === '^\\/?(?=\\/|$)') return '';
  return src
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\//g, '/');
}

export function listRoutes(app: Express, authHandler: RequestHandler): RegisteredRoute[] {
  const out: RegisteredRoute[] = [];
  const walk = (stack: Layer[], prefix: string, authSeen: boolean): void => {
    let auth = authSeen;
    for (const layer of stack) {
      if (layer.route) {
        const handlers = layer.route.stack;
        const guards = handlers.slice(0, -1).map((h) => h.name || 'anonymous');
        for (const method of Object.keys(layer.route.methods)) {
          out.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}`, authenticated: auth, guards });
        }
      } else if (layer.handle === authHandler) {
        auth = true; // everything mounted after this layer in the same router is behind auth
      } else if (layer.name === 'router' && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack, `${prefix}${mountPath(layer)}`, auth);
      }
    }
  };
  const root = (app as unknown as { _router?: { stack: Layer[] } })._router;
  if (!root) throw new Error('the app has no router yet (no routes registered)');
  walk(root.stack, '', false);
  return out;
}
