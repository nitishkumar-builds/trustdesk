import { Prisma, type Approval, type ToolActionRequest } from '@prisma/client';
import { newId } from '../../db/ids.js';
import { prisma } from '../../db/prisma.js';
import { conflictError, guardrailError, notFoundError, validationError } from '../../errors/AppError.js';
import type { Principal } from '../../middleware/auth.js';
import { blockedToolsForCase } from '../drafts/recommendationRules.js';
import { caseRuleContextForTicket } from '../drafts/service.js';
import { mapApproval, type ApprovalDto } from '../drafts/mappers.js';
import { mapToolActionRequest, type ToolActionRequestDto } from '../tickets/mappers.js';
import { getToolRegistry, type RegisteredTool } from './registry.js';
import { payloadSchemaFor, type ApproveBody, type RequestActionBody } from './schemas.js';
import type { ExecutorContext } from './types.js';

export interface ActionResponseDto extends ToolActionRequestDto {
  idempotent_replay: boolean;
  approvals: ApprovalDto[];
}

export interface RequestActionResult {
  action: ActionResponseDto;
  created: boolean;
}

const EXECUTABLE_FROM: Record<string, readonly string[]> = {
  approved: ['approved'],
  requested: ['requested'],
};

// ---------------------------------------------------------------------------
// requestAction — the validation chain (steps 1–9 of the Phase 7 prompt)
// ---------------------------------------------------------------------------

export async function requestAction(input: RequestActionBody, principal: Principal): Promise<RequestActionResult> {
  // 1. Tool exists.
  const registry = await getToolRegistry();
  const tool = registry.get(input.tool_name);
  if (!tool) throw notFoundError(`Tool ${input.tool_name} is not in the catalog`, { tool_name: input.tool_name });
  const def = tool.definition;

  // 2. Payload has every required field (Zod schema built from data/tool_actions.json).
  const parsed = payloadSchemaFor(def.requiredFields).safeParse(input.payload);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .filter((i) => i.code === 'invalid_type' && i.received === 'undefined')
      .map((i) => String(i.path[0]));
    const invalid = parsed.error.issues
      .filter((i) => !(i.code === 'invalid_type' && i.received === 'undefined'))
      .map((i) => `${i.path.join('.')}: ${i.message}`);
    throw validationError(
      missing.length > 0
        ? `Payload for ${def.toolName} is missing required fields: ${missing.join(', ')}`
        : `Payload for ${def.toolName} is invalid: ${invalid.join('; ')}`,
      { missing_fields: missing, invalid_fields: invalid, required_fields: def.requiredFields },
    );
  }
  const payload = parsed.data as Record<string, unknown>;
  const idempotencyKey = String(payload.idempotency_key);

  // 3. Ticket exists; its LATEST triage category must allow the tool (triage runs first if absent).
  const ticket = await prisma.ticket.findUnique({ where: { ticketId: input.ticket_id }, include: { customer: true, order: true } });
  if (!ticket) throw notFoundError(`Ticket ${input.ticket_id} not found`);
  const caseCtx = await caseRuleContextForTicket(ticket.ticketId, principal);
  if (!def.allowedCategories.includes(caseCtx.category)) {
    throw guardrailError(
      `Tool ${def.toolName} is not allowed for category ${caseCtx.category} (allowed: ${def.allowedCategories.join(', ')})`,
      { rule: 'category_not_allowed', category: caseCtx.category, tool_name: def.toolName, allowed_categories: def.allowedCategories },
    );
  }

  // 4. Case-level block: the Phase 6 rules, execution scope (CLAUDE.md D-049).
  const blocked = blockedToolsForCase(caseCtx, [def], 'execution').find((b) => b.tool_name === def.toolName);
  if (blocked) {
    throw guardrailError(`Tool ${def.toolName} is blocked for this case: ${blocked.detail}`, {
      rule: blocked.rule,
      reason: blocked.detail,
      tool_name: def.toolName,
      category: caseCtx.category,
    });
  }

  // 5. Coupon cap.
  if (def.toolName === 'issue_coupon' && def.maxAmountInr !== null && Number(payload.amount) > def.maxAmountInr) {
    throw guardrailError(`Coupon amount ${String(payload.amount)} exceeds the limit of INR ${def.maxAmountInr}`, {
      rule: 'coupon_amount_exceeds_limit',
      reason: 'coupon_amount_exceeds_limit',
      amount: payload.amount,
      max_amount_inr: def.maxAmountInr,
    });
  }

  // Referential checks so an approved action cannot fail on a bad id at execution time (D-050).
  assertPayloadReferences(def.toolName, payload, ticket);

  // 6. Idempotency (rule R6): an existing (tool, key) is returned as-is, never re-created or re-run.
  const existing = await prisma.toolActionRequest.findUnique({
    where: { toolName_idempotencyKey: { toolName: def.toolName, idempotencyKey } },
    include: { approvals: true },
  });
  if (existing) {
    await writeTrace({ action: existing, principal, replay: true, caseCtx });
    return { action: toDto(existing, true), created: false };
  }

  // 7. Create with the right initial status.
  const actionId = newId('action');
  let action: ToolActionRequest & { approvals: Approval[] };
  try {
    action = await prisma.toolActionRequest.create({
      data: {
        actionId,
        ticketId: ticket.ticketId,
        toolName: def.toolName,
        payload: payload as Prisma.InputJsonObject,
        riskLevel: def.riskLevel,
        requiresHumanApproval: def.requiresHumanApproval,
        status: def.requiresHumanApproval ? 'approval_required' : 'requested',
        idempotencyKey,
        requestedBy: principal.userId,
      },
      include: { approvals: true },
    });
  } catch (err) {
    // Two concurrent requests with the same key: the unique constraint decides, the loser re-reads.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.toolActionRequest.findUniqueOrThrow({
        where: { toolName_idempotencyKey: { toolName: def.toolName, idempotencyKey } },
        include: { approvals: true },
      });
      await writeTrace({ action: winner, principal, replay: true, caseCtx });
      return { action: toDto(winner, true), created: false };
    }
    throw err;
  }

  // 9. Trace (rule R7 family): every request writes a tool_recommendation run.
  await writeTrace({ action, principal, replay: false, caseCtx });

  // 8. Low-risk tools execute inside the same request.
  if (!def.requiresHumanApproval) {
    const { action: executed } = await runExecutor(action, tool, principal);
    return { action: toDto(executed, false), created: true };
  }
  return { action: toDto(action, false), created: true };
}

// ---------------------------------------------------------------------------
// approve / execute
// ---------------------------------------------------------------------------

export async function approveAction(actionId: string, body: ApproveBody, principal: Principal): Promise<ActionResponseDto> {
  const nextStatus = body.decision === 'approved' ? 'approved' : 'rejected';
  await prisma.$transaction(async (tx) => {
    // Conditional update: only approval_required moves, and only once even under concurrency.
    const moved = await tx.toolActionRequest.updateMany({ where: { actionId, status: 'approval_required' }, data: { status: nextStatus } });
    if (moved.count === 0) {
      const current = await tx.toolActionRequest.findUnique({ where: { actionId }, select: { status: true } });
      if (!current) throw notFoundError(`Action ${actionId} not found`);
      throw conflictError(`Action ${actionId} is ${current.status}; only approval_required actions can be approved or rejected`, {
        current_status: current.status,
        requested_decision: body.decision,
      });
    }
    await tx.approval.create({
      data: { approvalId: newId('approval'), actionId, reviewerId: principal.userId, decision: body.decision, reason: body.reason },
    });
  });
  const action = await prisma.toolActionRequest.findUniqueOrThrow({ where: { actionId }, include: { approvals: true } });
  return toDto(action, false);
}

export async function executeAction(actionId: string, principal: Principal): Promise<ActionResponseDto> {
  const action = await prisma.toolActionRequest.findUnique({ where: { actionId }, include: { approvals: true } });
  if (!action) throw notFoundError(`Action ${actionId} not found`);

  // Re-executing an executed action returns the stored result; the executor never runs again.
  if (action.status === 'executed') return toDto(action, true);

  const registry = await getToolRegistry();
  const tool = registry.get(action.toolName);
  if (!tool) throw notFoundError(`Tool ${action.toolName} is not in the catalog`);

  const from = tool.definition.requiresHumanApproval ? EXECUTABLE_FROM.approved! : EXECUTABLE_FROM.requested!;
  if (!from.includes(action.status)) {
    // The core guarantee: approval_required (and rejected/failed/cancelled) never executes.
    throw conflictError(`Action ${actionId} is ${action.status}; it can only be executed from ${from.join(' or ')}`, {
      current_status: action.status,
      executable_from: from,
      requires_human_approval: tool.definition.requiresHumanApproval,
    });
  }

  // A concurrent loser that lands after completion never ran the executor: that is a replay (D-051).
  const { action: executed, ran } = await runExecutor(action, tool, principal);
  return toDto(executed, !ran);
}

// Claims the action (status -> executing) with a conditional update so two concurrent executes
// run the executor once; the loser gets the stored result (ran: false) or a 409 while it is in flight.
async function runExecutor(
  action: ToolActionRequest & { approvals: Approval[] },
  tool: RegisteredTool,
  principal: Principal,
): Promise<{ action: ToolActionRequest & { approvals: Approval[] }; ran: boolean }> {
  const claimable = tool.definition.requiresHumanApproval ? ['approved'] : ['requested'];
  const claimed = await prisma.toolActionRequest.updateMany({
    where: { actionId: action.actionId, status: { in: claimable } },
    data: { status: 'executing' },
  });
  if (claimed.count === 0) {
    const current = await prisma.toolActionRequest.findUniqueOrThrow({ where: { actionId: action.actionId }, include: { approvals: true } });
    if (current.status === 'executed') return { action: current, ran: false };
    throw conflictError(`Action ${action.actionId} is ${current.status}; it cannot be executed now`, { current_status: current.status });
  }

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: action.ticketId }, include: { customer: true, order: true } });
  const ctx: ExecutorContext = { action, ticket, requestedBy: principal.userId };

  let ok = false;
  let result: Record<string, unknown>;
  try {
    ({ ok, result } = await tool.executor(action.payload as Record<string, unknown>, ctx));
  } catch (err) {
    ok = false;
    result = { simulated: true, error: err instanceof Error ? err.message : String(err) };
  }

  const stored = await prisma.toolActionRequest.update({
    where: { actionId: action.actionId },
    data: {
      status: ok ? 'executed' : 'failed',
      result: { ...result, executed_by: principal.userId } as Prisma.InputJsonObject,
      executedAt: new Date(),
    },
    include: { approvals: true },
  });
  return { action: stored, ran: true };
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function listActions(query: { ticket_id?: string; status?: string; tool_name?: string; limit: number }): Promise<{
  items: ActionResponseDto[];
  total: number;
}> {
  const items = await prisma.toolActionRequest.findMany({
    where: {
      ...(query.ticket_id ? { ticketId: query.ticket_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.tool_name ? { toolName: query.tool_name } : {}),
    },
    include: { approvals: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
  });
  return { items: items.map((a) => toDto(a, false)), total: items.length };
}

export async function getAction(actionId: string): Promise<ActionResponseDto> {
  const action = await prisma.toolActionRequest.findUnique({
    where: { actionId },
    include: { approvals: { orderBy: { createdAt: 'asc' } } },
  });
  if (!action) throw notFoundError(`Action ${actionId} not found`);
  return toDto(action, false);
}

export async function listCatalog(): Promise<{
  items: Array<{
    tool_name: string;
    description: string;
    risk_level: string;
    requires_human_approval: boolean;
    allowed_categories: string[];
    required_fields: string[];
    max_amount_inr: number | null;
  }>;
}> {
  const registry = await getToolRegistry();
  return {
    items: [...registry.values()].map(({ definition: d }) => ({
      tool_name: d.toolName,
      description: d.description,
      risk_level: d.riskLevel,
      requires_human_approval: d.requiresHumanApproval,
      allowed_categories: d.allowedCategories,
      required_fields: d.requiredFields,
      max_amount_inr: d.maxAmountInr,
    })),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toDto(action: ToolActionRequest & { approvals: Approval[] }, replay: boolean): ActionResponseDto {
  return { ...mapToolActionRequest(action), idempotent_replay: replay, approvals: action.approvals.map(mapApproval) };
}

// order_id / customer_id / ticket_id in a payload must refer to the ticket's own records.
function assertPayloadReferences(
  toolName: string,
  payload: Record<string, unknown>,
  ticket: { ticketId: string; customerId: string; order: { orderId: string; total: number } | null },
): void {
  if ('order_id' in payload) {
    if (!ticket.order) throw validationError(`Ticket ${ticket.ticketId} has no linked order`, { field: 'order_id' });
    if (payload.order_id !== ticket.order.orderId) {
      throw validationError(`order_id ${String(payload.order_id)} is not the order linked to ticket ${ticket.ticketId}`, {
        field: 'order_id',
        ticket_order_id: ticket.order.orderId,
      });
    }
    if (toolName === 'start_refund_review' && Number(payload.amount) > ticket.order.total) {
      throw validationError(`amount ${String(payload.amount)} exceeds the order total ${ticket.order.total}`, {
        field: 'amount',
        order_total: ticket.order.total,
      });
    }
  }
  if ('customer_id' in payload && payload.customer_id !== ticket.customerId) {
    throw validationError(`customer_id ${String(payload.customer_id)} is not the customer on ticket ${ticket.ticketId}`, {
      field: 'customer_id',
      ticket_customer_id: ticket.customerId,
    });
  }
  if ('ticket_id' in payload && payload.ticket_id !== ticket.ticketId) {
    throw validationError(`payload.ticket_id ${String(payload.ticket_id)} does not match the request ticket ${ticket.ticketId}`, {
      field: 'ticket_id',
    });
  }
}

async function writeTrace(input: {
  action: ToolActionRequest;
  principal: Principal;
  replay: boolean;
  caseCtx: Awaited<ReturnType<typeof caseRuleContextForTicket>>;
}): Promise<void> {
  await prisma.agentRun.create({
    data: {
      runId: newId('run'),
      ticketId: input.action.ticketId,
      runType: 'tool_recommendation',
      status: 'completed',
      retrievedDocIds: [],
      toolCalls: [
        {
          action_id: input.action.actionId,
          tool_name: input.action.toolName,
          status: input.action.status,
          idempotency_key: input.action.idempotencyKey,
          requested_by: input.principal.userId,
          idempotent_replay: input.replay,
        },
      ] as unknown as Prisma.InputJsonArray,
      guardrailResults: {
        validation: 'passed',
        category: input.caseCtx.category,
        guardrail_outcome: input.caseCtx.guardrailOutcome,
        safety_case: input.caseCtx.safetyCase,
        idempotent_replay: input.replay,
      } as unknown as Prisma.InputJsonObject,
      modelProvider: 'none',
      promptVersion: null,
    },
  });
}
