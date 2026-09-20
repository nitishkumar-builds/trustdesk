import { mapOrder } from '../../orders/mappers.js';
import type { ToolExecutor } from '../types.js';
import { shortId } from './ids.js';

// Simulated: creates a replacement order id and echoes the original order. No external call.
export const createReplacementOrder: ToolExecutor = async (payload, ctx) => {
  const order = ctx.ticket.order;
  if (!order || order.orderId !== payload.order_id) {
    return { ok: false, result: { simulated: true, error: `order ${String(payload.order_id)} is not linked to ticket ${ctx.ticket.ticketId}` } };
  }
  return {
    ok: true,
    result: {
      simulated: true,
      replacement_order_id: `ord_r_${shortId()}`,
      original_order: mapOrder(order),
      sku: payload.sku,
      reason: payload.reason,
      status: 'replacement_created',
      note: 'Simulated fulfilment: no warehouse or carrier system was called.',
    },
  };
};
