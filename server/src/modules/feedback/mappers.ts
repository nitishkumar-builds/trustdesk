import type { Feedback } from '@prisma/client';

export interface FeedbackDto {
  feedback_id: string;
  ticket_id: string;
  draft_id: string | null;
  rating: number;
  reason: string | null;
  corrected_response: string | null;
  created_at: string;
}

export function mapFeedback(f: Feedback): FeedbackDto {
  return {
    feedback_id: f.feedbackId,
    ticket_id: f.ticketId,
    draft_id: f.draftId,
    rating: f.rating,
    reason: f.reason,
    corrected_response: f.correctedResponse,
    created_at: f.createdAt.toISOString(),
  };
}
