import type { ToolExecutor } from '../types.js';
import { createReplacementOrder } from './create_replacement_order.js';
import { escalateToHuman } from './escalate_to_human.js';
import { issueCoupon } from './issue_coupon.js';
import { lockAccount } from './lock_account.js';
import { openCarrierInvestigation } from './open_carrier_investigation.js';
import { startRefundReview } from './start_refund_review.js';

// One executor per tool_name in data/tool_actions.json. The registry refuses to boot if a
// ToolDefinition row has no executor here.
export const EXECUTORS: Readonly<Record<string, ToolExecutor>> = Object.freeze({
  create_replacement_order: createReplacementOrder,
  start_refund_review: startRefundReview,
  open_carrier_investigation: openCarrierInvestigation,
  escalate_to_human: escalateToHuman,
  issue_coupon: issueCoupon,
  lock_account: lockAccount,
});
