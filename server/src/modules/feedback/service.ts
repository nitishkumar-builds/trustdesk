// Reviewer feedback on drafts (Phase 11 item 2). The Feedback table has existed since Phase 1;
// the rating is 1-5 (the UI's thumbs map to 5 and 1), reason and corrected_response are optional.
import { newId } from '../../db/ids.js';
import { prisma } from '../../db/prisma.js';
import { notFoundError, validationError } from '../../errors/AppError.js';
import { mapFeedback, type FeedbackDto } from './mappers.js';
import type { CreateFeedbackBody, ListFeedbackQuery } from './schemas.js';

export async function createFeedback(body: CreateFeedbackBody): Promise<FeedbackDto> {
  const ticket = await prisma.ticket.findUnique({ where: { ticketId: body.ticket_id }, select: { ticketId: true } });
  if (!ticket) throw notFoundError(`Ticket ${body.ticket_id} not found`);
  if (body.draft_id) {
    const draft = await prisma.draftReply.findUnique({ where: { draftId: body.draft_id }, select: { draftId: true, ticketId: true } });
    if (!draft) throw notFoundError(`Draft ${body.draft_id} not found`);
    if (draft.ticketId !== body.ticket_id) {
      throw validationError(`Draft ${body.draft_id} belongs to ticket ${draft.ticketId}, not ${body.ticket_id}`, { field: 'draft_id', draft_ticket_id: draft.ticketId });
    }
  }
  const row = await prisma.feedback.create({
    data: {
      feedbackId: newId('feedback'),
      ticketId: body.ticket_id,
      draftId: body.draft_id ?? null,
      rating: body.rating,
      reason: body.reason ?? null,
      correctedResponse: body.corrected_response ?? null,
    },
  });
  return mapFeedback(row);
}

export async function listFeedback(query: ListFeedbackQuery): Promise<{ items: FeedbackDto[]; total: number; average_rating: number | null }> {
  const where = {
    ...(query.ticket_id ? { ticketId: query.ticket_id } : {}),
    ...(query.draft_id ? { draftId: query.draft_id } : {}),
  };
  const [rows, total, avg] = await Promise.all([
    prisma.feedback.findMany({ where, orderBy: { createdAt: 'desc' }, take: query.limit }),
    prisma.feedback.count({ where }),
    prisma.feedback.aggregate({ where, _avg: { rating: true } }),
  ]);
  const average = avg._avg.rating;
  return { items: rows.map(mapFeedback), total, average_rating: average === null ? null : Math.round(average * 100) / 100 };
}
