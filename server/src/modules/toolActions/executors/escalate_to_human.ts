import type { ToolExecutor } from '../types.js';
import { shortId } from './ids.js';

// Simulated: routes the ticket to a specialist queue. Low risk, executes without approval.
export const escalateToHuman: ToolExecutor = async (payload, ctx) => ({
  ok: true,
  result: {
    simulated: true,
    escalation_id: `esc_${shortId()}`,
    ticket_id: ctx.ticket.ticketId,
    queue: payload.queue,
    reason: payload.reason,
    assigned_to: `specialist-queue:${String(payload.queue)}`,
    status: 'queued',
    note: 'Simulated: no ticketing or paging system was called.',
  },
});
