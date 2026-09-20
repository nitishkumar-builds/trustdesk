import type {
  Customer,
  DraftReply,
  Order,
  Ticket,
  ToolActionRequest,
  TriageResult,
} from '@prisma/client';
import type { ReturnWindowStatus, WarrantyStatus } from '../../domain/policyWindows.js';
import { mapCustomer, mapCustomerSummary, type CustomerDto, type CustomerSummaryDto } from '../customers/mappers.js';
import { mapOrder, type OrderDto } from '../orders/mappers.js';

// Every DTO here is snake_case and built by hand: Prisma rows never leak, and nothing from
// TicketExpectation is ever mapped (rule R2).

export interface TriageSummaryDto {
  category: string;
  priority: string;
  should_escalate: boolean;
}

export interface TriageDto extends TriageSummaryDto {
  sentiment: string;
  reason_summary: string;
  run_id: string;
  created_at: string;
}

export interface TicketListItemDto {
  ticket_id: string;
  subject: string;
  channel: string;
  status: string;
  created_at: string;
  customer: CustomerSummaryDto;
  latest_triage: TriageSummaryDto | null;
}

export interface DraftSummaryDto {
  draft_id: string;
  status: string;
  created_at: string;
  citations: string[];
}

export interface ToolActionRequestDto {
  action_id: string;
  ticket_id: string;
  tool_name: string;
  payload: unknown;
  risk_level: string;
  requires_human_approval: boolean;
  status: string;
  idempotency_key: string;
  requested_by: string;
  result: unknown | null;
  created_at: string;
  executed_at: string | null;
}

export interface PolicyContextDto {
  as_of: string;
  return_window: {
    eligible: boolean;
    reason: string;
    window_ends_at: string | null;
  } | null;
  warranty: {
    covered: boolean;
    months_since_delivery: number | null;
    window_months: number;
    extension_applied: boolean;
    reason: string;
  } | null;
}

export interface TicketDto {
  ticket_id: string;
  customer_id: string;
  order_id: string | null;
  channel: string;
  subject: string;
  body: string;
  created_at: string;
  status: string;
}

export interface TicketDetailDto extends TicketDto {
  customer: CustomerDto;
  order: OrderDto | null;
  latest_triage: TriageDto | null;
  drafts: DraftSummaryDto[];
  tool_action_requests: ToolActionRequestDto[];
  policy_context: PolicyContextDto;
}

export function mapTriageSummary(t: TriageResult): TriageSummaryDto {
  return { category: t.category, priority: t.priority, should_escalate: t.shouldEscalate };
}

export function mapTriage(t: TriageResult): TriageDto {
  return {
    ...mapTriageSummary(t),
    sentiment: t.sentiment,
    reason_summary: t.reasonSummary,
    run_id: t.runId,
    created_at: t.createdAt.toISOString(),
  };
}

export function mapTicket(t: Ticket): TicketDto {
  return {
    ticket_id: t.ticketId,
    customer_id: t.customerId,
    order_id: t.orderId,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    created_at: t.createdAt.toISOString(),
    status: t.status,
  };
}

export function mapTicketListItem(
  t: Ticket & { customer: Customer; triageResults: TriageResult[] },
): TicketListItemDto {
  const latest = t.triageResults[0];
  return {
    ticket_id: t.ticketId,
    subject: t.subject,
    channel: t.channel,
    status: t.status,
    created_at: t.createdAt.toISOString(),
    customer: mapCustomerSummary(t.customer),
    latest_triage: latest ? mapTriageSummary(latest) : null,
  };
}

export function mapDraftSummary(d: DraftReply): DraftSummaryDto {
  return {
    draft_id: d.draftId,
    status: d.status,
    created_at: d.createdAt.toISOString(),
    citations: d.citations,
  };
}

export function mapToolActionRequest(a: ToolActionRequest): ToolActionRequestDto {
  return {
    action_id: a.actionId,
    ticket_id: a.ticketId,
    tool_name: a.toolName,
    payload: a.payload,
    risk_level: a.riskLevel,
    requires_human_approval: a.requiresHumanApproval,
    status: a.status,
    idempotency_key: a.idempotencyKey,
    requested_by: a.requestedBy,
    result: a.result ?? null,
    created_at: a.createdAt.toISOString(),
    executed_at: a.executedAt?.toISOString() ?? null,
  };
}

export function mapPolicyContext(input: {
  asOf: Date;
  returnWindow: ReturnWindowStatus | null;
  warranty: WarrantyStatus | null;
}): PolicyContextDto {
  return {
    as_of: input.asOf.toISOString(),
    return_window: input.returnWindow
      ? {
          eligible: input.returnWindow.eligible,
          reason: input.returnWindow.reason,
          window_ends_at: input.returnWindow.windowEndsAt?.toISOString() ?? null,
        }
      : null,
    warranty: input.warranty
      ? {
          covered: input.warranty.covered,
          months_since_delivery: input.warranty.monthsSinceDelivery,
          window_months: input.warranty.windowMonths,
          extension_applied: input.warranty.extensionApplied,
          reason: input.warranty.reason,
        }
      : null,
  };
}

export function mapTicketDetail(input: {
  ticket: Ticket & {
    customer: Customer;
    order: Order | null;
    triageResults: TriageResult[];
    drafts: DraftReply[];
    toolActionRequests: ToolActionRequest[];
  };
  policyContext: PolicyContextDto;
}): TicketDetailDto {
  const { ticket, policyContext } = input;
  const latest = ticket.triageResults[0];
  return {
    ...mapTicket(ticket),
    customer: mapCustomer(ticket.customer),
    order: ticket.order ? mapOrder(ticket.order) : null,
    latest_triage: latest ? mapTriage(latest) : null,
    drafts: ticket.drafts.map(mapDraftSummary),
    tool_action_requests: ticket.toolActionRequests.map(mapToolActionRequest),
    policy_context: policyContext,
  };
}
