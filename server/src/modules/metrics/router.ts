import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { metricsSummary } from './service.js';

const querySchema = z.object({
  since: z.coerce.date().optional(),
  ticket_id: z.string().min(1).optional(),
});

// Mounted under /api by app.ts (requireAuth applied).
export const router = Router();

// GET /api/metrics/summary?since=&ticket_id=  [any role] — runs per type, p50/p95 latency, tokens, estimated cost
router.get(
  '/metrics/summary',
  asyncHandler(async (req, res) => {
    const { since, ticket_id } = querySchema.parse(req.query);
    res.json(await metricsSummary({ since, ticketId: ticket_id }));
  }),
);
