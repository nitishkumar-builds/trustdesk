import type { ToolExecutor } from '../types.js';
import { shortId } from './ids.js';

// Simulated: opens a human-reviewed refund workflow. It never moves money.
export const startRefundReview: ToolExecutor = async (payload, ctx) => {
  const order = ctx.ticket.order;
  if (!order || order.orderId !== payload.order_id) {
    return { ok: false, result: { simulated: true, error: `order ${String(payload.order_id)} is not linked to ticket ${ctx.ticket.ticketId}` } };
  }
  return {
    ok: true,
    result: {
      simulated: true,
      review_id: `rr_${shortId()}`,
      order_id: order.orderId,
      amount: payload.amount,
      currency: order.currency,
      reason: payload.reason,
      status: 'pending_payment_operations',
      note: 'Simulated: payment operations must confirm before any money moves.',
    },
  };
};
