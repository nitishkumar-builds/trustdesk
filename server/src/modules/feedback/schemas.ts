import { z } from 'zod';

// POST /api/feedback { ticket_id, draft_id?, rating 1-5, reason?, corrected_response? }
export const createFeedbackBodySchema = z.object({
  ticket_id: z.string().min(1),
  draft_id: z.string().min(1).optional(),
  rating: z.number().int().min(1).max(5),
  reason: z.string().trim().min(1).max(2000).optional(),
  corrected_response: z.string().trim().min(1).max(20000).optional(),
});
export type CreateFeedbackBody = z.infer<typeof createFeedbackBodySchema>;

export const listFeedbackQuerySchema = z.object({
  ticket_id: z.string().min(1).optional(),
  draft_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListFeedbackQuery = z.infer<typeof listFeedbackQuerySchema>;
