import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { createTicketBodySchema, listTicketsQuerySchema, ticketIdParamSchema } from './schemas.js';
import { createTicket, getTicketDetail, listTickets } from './service.js';

// Mounted under /api by app.ts; requireAuth is applied to the whole /api prefix.
export const router = Router();

// GET /api/tickets  [any role]
router.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const query = listTicketsQuerySchema.parse(req.query);
    res.json(await listTickets(query));
  }),
);

// GET /api/tickets/:ticketId  [any role]
router.get(
  '/tickets/:ticketId',
  asyncHandler(async (req, res) => {
    const { ticketId } = ticketIdParamSchema.parse(req.params);
    res.json(await getTicketDetail(ticketId));
  }),
);

// POST /api/tickets  [any role]
router.post(
  '/tickets',
  asyncHandler(async (req, res) => {
    const body = createTicketBodySchema.parse(req.body);
    res.status(201).json(await createTicket(body));
  }),
);
