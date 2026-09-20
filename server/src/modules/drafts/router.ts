import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { getPrincipal } from '../../middleware/auth.js';
import { draftIdParamSchema, patchDraftBodySchema, ticketIdParamSchema } from './schemas.js';
import { generateDraft, getDraft, listDraftsForTicket, patchDraft } from './service.js';

// Mounted under /api by app.ts (requireAuth applied). All routes: support_agent or above.
export const router = Router();

// POST /api/tickets/:ticketId/draft-reply
router.post(
  '/tickets/:ticketId/draft-reply',
  asyncHandler(async (req, res) => {
    const { ticketId } = ticketIdParamSchema.parse(req.params);
    res.json(await generateDraft(ticketId, getPrincipal(req)));
  }),
);

// GET /api/tickets/:ticketId/drafts
router.get(
  '/tickets/:ticketId/drafts',
  asyncHandler(async (req, res) => {
    const { ticketId } = ticketIdParamSchema.parse(req.params);
    res.json(await listDraftsForTicket(ticketId));
  }),
);

// GET /api/drafts/:draftId
router.get(
  '/drafts/:draftId',
  asyncHandler(async (req, res) => {
    const { draftId } = draftIdParamSchema.parse(req.params);
    res.json(await getDraft(draftId));
  }),
);

// PATCH /api/drafts/:draftId  { status: edited|approved|rejected|sent, body?, reason? }
router.patch(
  '/drafts/:draftId',
  asyncHandler(async (req, res) => {
    const { draftId } = draftIdParamSchema.parse(req.params);
    const body = patchDraftBodySchema.parse(req.body);
    res.json(await patchDraft(draftId, body, getPrincipal(req)));
  }),
);
