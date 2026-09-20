import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getPrincipal } from '../../middleware/auth.js';
import { currentUser, login, loginBodySchema } from './service.js';

// POST /api/auth/login is the second unauthenticated route (with GET /health): it is mounted in
// app.ts BEFORE requireAuth. `router` is mounted with the other feature routers, behind requireAuth.
export const openRouter = Router();

// POST /api/auth/login { email, password } -> { token, token_type, expires_in, user }
openRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = loginBodySchema.parse(req.body);
    res.json(await login(body));
  }),
);

export const router = Router();

// GET /api/auth/me  [any role] — who the bearer token (JWT or demo token) resolves to
router.get(
  '/auth/me',
  asyncHandler(async (req, res) => {
    res.json(await currentUser(getPrincipal(req)));
  }),
);
