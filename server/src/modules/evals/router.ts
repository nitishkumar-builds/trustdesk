import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getPrincipal } from '../../middleware/auth.js';
import { evalRunIdParamSchema, listEvalRunsQuerySchema, startEvalRunBodySchema } from './schemas.js';
import { getEvalRun, listEvalRuns, startEvalRun } from './service.js';

// Mounted under /api by app.ts (requireAuth applied).
export const router = Router();

// POST /api/eval-runs  [admin ONLY — middleware/policy.ts] -> 202 { eval_run_id, status: 'running' }; completes in the background
router.post(
  '/eval-runs',
  asyncHandler(async (req, res) => {
    const body = startEvalRunBodySchema.parse(req.body);
    res.status(202).json(await startEvalRun(body, getPrincipal(req)));
  }),
);

// GET /api/eval-runs?limit=  [any role] -> past runs, newest first
router.get(
  '/eval-runs',
  asyncHandler(async (req, res) => {
    const query = listEvalRunsQuerySchema.parse(req.query);
    res.json(await listEvalRuns(query.limit));
  }),
);

// GET /api/eval-runs/:evalRunId  [any role] -> status plus full results
router.get(
  '/eval-runs/:evalRunId',
  asyncHandler(async (req, res) => {
    const { evalRunId } = evalRunIdParamSchema.parse(req.params);
    res.json(await getEvalRun(evalRunId));
  }),
);
