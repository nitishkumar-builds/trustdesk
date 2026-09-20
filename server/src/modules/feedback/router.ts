import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { createFeedbackBodySchema, listFeedbackQuerySchema } from './schemas.js';
import { createFeedback, listFeedback } from './service.js';

// Mounted under /api by app.ts (requireAuth applied). Any role may leave or read feedback.
export const router = Router();

// POST /api/feedback  { ticket_id, draft_id?, rating 1-5, reason?, corrected_response? } -> 201
router.post(
  '/feedback',
  asyncHandler(async (req, res) => {
    const body = createFeedbackBodySchema.parse(req.body);
    res.status(201).json(await createFeedback(body));
  }),
);

// GET /api/feedback?ticket_id=&draft_id=&limit=  -> newest first, with the average rating
router.get(
  '/feedback',
  asyncHandler(async (req, res) => {
    const query = listFeedbackQuerySchema.parse(req.query);
    res.json(await listFeedback(query));
  }),
);
