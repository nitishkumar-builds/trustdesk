import { z } from 'zod';

export const TICKET_CHANNELS = ['email', 'chat', 'web', 'phone'] as const;

export const listTicketsQuerySchema = z.object({
  status: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const ticketIdParamSchema = z.object({
  ticketId: z.string().min(1),
});

export const createTicketBodySchema = z.object({
  customer_id: z.string().min(1),
  order_id: z.string().min(1).optional(),
  channel: z.enum(TICKET_CHANNELS),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
});
export type CreateTicketBody = z.infer<typeof createTicketBodySchema>;
