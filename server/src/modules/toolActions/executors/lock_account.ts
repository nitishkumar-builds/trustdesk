import type { ToolExecutor } from '../types.js';

// Simulated: high-risk, approval-gated. Records the lock decision; never touches auth systems.
export const lockAccount: ToolExecutor = async (payload, ctx) => ({
  ok: true,
  result: {
    simulated: true,
    customer_id: ctx.ticket.customerId,
    locked: true,
    reason: payload.reason,
    status: 'locked_simulated',
    note: 'Simulated: no identity or auth system was called.',
  },
});
