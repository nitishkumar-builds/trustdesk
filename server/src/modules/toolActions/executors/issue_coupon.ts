import type { ToolExecutor } from '../types.js';
import { shortId } from './ids.js';

// Simulated: registered, validated (amount cap enforced at request time) and approval-gated.
export const issueCoupon: ToolExecutor = async (payload, ctx) => ({
  ok: true,
  result: {
    simulated: true,
    coupon_code: `GW-${shortId().toUpperCase()}`,
    customer_id: ctx.ticket.customerId,
    amount: payload.amount,
    currency: 'INR',
    reason: payload.reason,
    status: 'issued_simulated',
    note: 'Simulated: no coupon or promotions system was called.',
  },
});
