import type { ToolExecutor } from '../types.js';
import { shortId } from './ids.js';

// Simulated: files a carrier investigation. Low risk, executes without approval.
export const openCarrierInvestigation: ToolExecutor = async (payload, ctx) => {
  const order = ctx.ticket.order;
  if (!order || order.orderId !== payload.order_id) {
    return { ok: false, result: { simulated: true, error: `order ${String(payload.order_id)} is not linked to ticket ${ctx.ticket.ticketId}` } };
  }
  return {
    ok: true,
    result: {
      simulated: true,
      investigation_id: `inv_${shortId()}`,
      order_id: order.orderId,
      tracking_number: payload.tracking_number,
      carrier: 'BlueTrack (simulated)',
      status: 'open',
      carrier_confirmed_lost: false,
      expected_update_business_days: 3,
      note: 'Simulated: no carrier API was called; an executed investigation with carrier_confirmed_lost=true lifts the stale-tracking gate.',
    },
  };
};
