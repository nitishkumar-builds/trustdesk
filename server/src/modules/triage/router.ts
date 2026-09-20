import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getPrincipal } from '../../middleware/auth.js';
import { triageTicket } from './service.js';

const paramsSchema = z.object({ ticketId: z.string().min(1) });

export const router = Router();

// POST /api/tickets/:ticketId/triage  [support_agent or above = any authenticated role]
// Re-running creates a new TriageResult and a new AgentRun; GET /api/tickets/:id shows the latest.
router.post(
  '/tickets/:ticketId/triage',
  asyncHandler(async (req, res) => {
    const { ticketId } = paramsSchema.parse(req.params);
    res.json(await triageTicket(ticketId, getPrincipal(req)));
  }),
);
