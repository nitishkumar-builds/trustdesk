import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { notFoundError } from '../../errors/AppError.js';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { mapAgentRun } from './mappers.js';

const RUN_TYPES = ['triage', 'draft_reply', 'tool_recommendation', 'eval_case'] as const;

const listQuerySchema = z.object({
  ticket_id: z.string().min(1).optional(),
  run_type: z.enum(RUN_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const paramsSchema = z.object({ runId: z.string().min(1) });

export const router = Router();

// GET /api/agent-runs?ticket_id=&run_type=&limit=  [any role] — newest first
router.get(
  '/agent-runs',
  asyncHandler(async (req, res) => {
    const { ticket_id, run_type, limit } = listQuerySchema.parse(req.query);
    const runs = await prisma.agentRun.findMany({
      where: {
        ...(ticket_id ? { ticketId: ticket_id } : {}),
        ...(run_type ? { runType: run_type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ items: runs.map(mapAgentRun), total: runs.length });
  }),
);

// GET /api/agent-runs/:runId  [any role] — full trace
router.get(
  '/agent-runs/:runId',
  asyncHandler(async (req, res) => {
    const { runId } = paramsSchema.parse(req.params);
    const run = await prisma.agentRun.findUnique({ where: { runId } });
    if (!run) throw notFoundError(`Agent run ${runId} not found`);
    res.json(mapAgentRun(run));
  }),
);
