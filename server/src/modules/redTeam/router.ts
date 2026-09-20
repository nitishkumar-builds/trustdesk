import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { listFlaggedRuns, probeText } from './service.js';

const probeBodySchema = z.object({ text: z.string().trim().min(1).max(20000) });
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) });

// Mounted under /api by app.ts (requireAuth applied). Any role may review flagged runs and probe text.
export const router = Router();

// POST /api/red-team/probe { text } -> input scan + post-rules + guardrail decision, nothing persisted
router.post(
  '/red-team/probe',
  asyncHandler(async (req, res) => {
    const { text } = probeBodySchema.parse(req.body);
    res.json(probeText(text));
  }),
);

// GET /api/red-team/runs?limit=&offset= -> AgentRuns whose input scan flagged the customer text, newest first
router.get(
  '/red-team/runs',
  asyncHandler(async (req, res) => {
    const { limit, offset } = listQuerySchema.parse(req.query);
    res.json(await listFlaggedRuns(limit, offset));
  }),
);
