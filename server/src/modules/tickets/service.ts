import { randomBytes } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { returnWindowStatus, toPolicyOrder, warrantyStatus } from '../../domain/policyWindows.js';
import { notFoundError, validationError } from '../../errors/AppError.js';
import {
  mapPolicyContext,
  mapTicket,
  mapTicketDetail,
  mapTicketListItem,
  type PolicyContextDto,
  type TicketDetailDto,
  type TicketDto,
  type TicketListItemDto,
} from './mappers.js';
import type { CreateTicketBody, ListTicketsQuery } from './schemas.js';

export interface TicketListResult {
  items: TicketListItemDto[];
  page: number;
  page_size: number;
  total: number;
}

// Latest triage first, so triageResults[0] is always "the" current result.
const latestTriageInclude = { orderBy: { createdAt: 'desc' as const }, take: 1 };

export async function listTickets(query: ListTicketsQuery): Promise<TicketListResult> {
  const { status, category, page, pageSize } = query;
  const where = status ? { status } : {};

  if (category) {
    // "category" means the LATEST triage category, which is not expressible as a Prisma
    // filter (a `some` clause would match any past triage). Filter in memory (CLAUDE.md D-021).
    const all = await prisma.ticket.findMany({
      where,
      include: { customer: true, triageResults: latestTriageInclude },
      orderBy: { createdAt: 'asc' },
    });
    const matching = all.filter((t) => t.triageResults[0]?.category === category);
    const start = (page - 1) * pageSize;
    return {
      items: matching.slice(start, start + pageSize).map(mapTicketListItem),
      page,
      page_size: pageSize,
      total: matching.length,
    };
  }

  const [rows, total] = await Promise.all([
    prisma.ticket.findMany({
      where,
      include: { customer: true, triageResults: latestTriageInclude },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.ticket.count({ where }),
  ]);

  return { items: rows.map(mapTicketListItem), page, page_size: pageSize, total };
}

export async function getTicketDetail(ticketId: string): Promise<TicketDetailDto> {
  const ticket = await prisma.ticket.findUnique({
    where: { ticketId },
    include: {
      customer: true,
      order: true,
      triageResults: latestTriageInclude,
      drafts: { orderBy: { createdAt: 'desc' } },
      toolActionRequests: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!ticket) throw notFoundError(`Ticket ${ticketId} not found`);

  return mapTicketDetail({
    ticket,
    policyContext: buildPolicyContext(ticket),
  });
}

// Rule R1: asOf is the ticket's created_at, never the clock.
export function buildPolicyContext(ticket: {
  createdAt: Date;
  customer: { tier: string };
  order: {
    orderId: string;
    deliveredAt: Date | null;
    eligibleReturnUntil: Date | null;
    total: number;
    items: unknown;
  } | null;
}): PolicyContextDto {
  const asOf = ticket.createdAt;
  if (!ticket.order) {
    return mapPolicyContext({ asOf, returnWindow: null, warranty: null });
  }
  const order = toPolicyOrder(ticket.order);
  return mapPolicyContext({
    asOf,
    returnWindow: returnWindowStatus({ order, asOf }),
    warranty: warrantyStatus({ order, customer: ticket.customer, asOf }),
  });
}

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateTicketId(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (const b of bytes) suffix += ALPHANUMERIC[b % ALPHANUMERIC.length];
  return `tkt_${suffix}`;
}

export async function createTicket(body: CreateTicketBody): Promise<TicketDto> {
  const customer = await prisma.customer.findUnique({ where: { customerId: body.customer_id } });
  if (!customer) throw notFoundError(`Customer ${body.customer_id} not found`);

  if (body.order_id) {
    const order = await prisma.order.findUnique({ where: { orderId: body.order_id } });
    if (!order) throw notFoundError(`Order ${body.order_id} not found`);
    if (order.customerId !== customer.customerId) {
      throw validationError(`Order ${body.order_id} does not belong to customer ${body.customer_id}`, {
        order_customer_id: order.customerId,
      });
    }
  }

  // A brand-new ticket is created "now"; rule R1 governs policy evaluation, not ticket creation.
  const ticket = await prisma.ticket.create({
    data: {
      ticketId: generateTicketId(),
      customerId: body.customer_id,
      orderId: body.order_id ?? null,
      channel: body.channel,
      subject: body.subject,
      body: body.body, // verbatim, never trimmed or rewritten
      createdAt: new Date(),
      status: 'open',
    },
  });
  return mapTicket(ticket);
}
