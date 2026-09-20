import type { ToolDefinition } from '@prisma/client';
import { businessDaysBetween } from '../../domain/businessDays.js';
import type { ReturnWindowStatus } from '../../domain/policyWindows.js';
import type { GuardrailOutcome } from '../../guardrails/policy.js';

/**
 * Deterministic recommendation rules, applied AFTER the model and authoritative over it
 * (rule R5: the AI only recommends, and only what policy supports for this case).
 *
 * The same rules gate execution requests in Phase 7 (`blockedToolsForCase`), so a
 * catalog-valid but case-invalid action (create_replacement_order on a safety ticket) is
 * refused there too — docs/EVALUATION_GUIDE.md: catalog-valid is not the same as case-allowed.
 */

export const ESCALATE_TOOL = 'escalate_to_human';
export const STALE_TRACKING_RESOLUTION_BUSINESS_DAYS = 10;
export const DISPATCH_LEAD_BUSINESS_DAYS = 1; // KB-SHIPPING-001: most orders ship within 1 business day

export interface ProposedAction {
  tool_name: string;
  reason: string;
}

export interface Recommendation extends ProposedAction {
  requires_human_approval: boolean;
}

export interface StrippedRecommendation extends ProposedAction {
  rule: string;
  detail: string;
}

export interface ShippingCaseFacts {
  delivered: boolean;
  businessDaysSinceDispatch: number | null;
  carrierConfirmed: boolean;
  staleTrackingUnderThreshold: boolean;
}

export interface CaseRuleContext {
  category: string;
  guardrailOutcome: GuardrailOutcome;
  /** PR1 (safety) fired in triage for this ticket. */
  safetyCase: boolean;
  returnWindow: ReturnWindowStatus | null;
  shipping: ShippingCaseFacts | null;
}

export interface RecommendationResult {
  recommendations: Recommendation[];
  stripped: StrippedRecommendation[];
}

// Shipping facts derived from the order and the ticket's created_at (rule R1: asOf, not now).
export function shippingCaseFacts(input: {
  order: { placedAt: Date; deliveredAt: Date | null } | null;
  asOf: Date;
  carrierConfirmed: boolean;
}): ShippingCaseFacts | null {
  if (!input.order) return null;
  const delivered = input.order.deliveredAt !== null;
  const dispatchLead = DISPATCH_LEAD_BUSINESS_DAYS;
  const sinceDispatch = Math.max(0, businessDaysBetween(input.order.placedAt, input.asOf) - dispatchLead);
  return {
    delivered,
    businessDaysSinceDispatch: sinceDispatch,
    carrierConfirmed: input.carrierConfirmed,
    staleTrackingUnderThreshold:
      !delivered && !input.carrierConfirmed && sinceDispatch < STALE_TRACKING_RESOLUTION_BUSINESS_DAYS,
  };
}

/**
 * Applies the rules to what the model proposed. Order of evaluation, first strip wins:
 *   1. unknown tool                       -> strip
 *   2. tool not allowed for the category  -> strip
 *   3. guardrail refuse_and_escalate      -> only escalate_to_human survives
 *   4. safety case (PR1)                  -> only escalate_to_human survives
 *   5. return window not eligible (refund category) -> strip start_refund_review, create_replacement_order
 *   6. shipping, stale tracking < 10 business days, no carrier confirmation
 *                                         -> strip create_replacement_order, start_refund_review
 *   7. issue_coupon                       -> always stripped (never auto-recommended, CLAUDE.md D-044)
 * Survivors are de-duplicated and annotated with requires_human_approval from ToolDefinition.
 */
export function applyRecommendationRules(
  proposed: ProposedAction[],
  ctx: CaseRuleContext,
  tools: Pick<ToolDefinition, 'toolName' | 'allowedCategories' | 'requiresHumanApproval'>[],
): RecommendationResult {
  const byName = new Map(tools.map((t) => [t.toolName, t]));
  const recommendations: Recommendation[] = [];
  const stripped: StrippedRecommendation[] = [];
  const seen = new Set<string>();

  for (const action of proposed) {
    const name = action.tool_name;
    if (seen.has(name)) continue;
    seen.add(name);

    const verdict = evaluateTool(name, ctx, byName.get(name));
    if (verdict) {
      stripped.push({ ...action, rule: verdict.rule, detail: verdict.detail });
      continue;
    }
    recommendations.push({
      tool_name: name,
      reason: action.reason,
      requires_human_approval: byName.get(name)!.requiresHumanApproval,
    });
  }

  return { recommendations, stripped };
}

/**
 * Which rule set applies:
 *  - 'recommendation' (default): everything, for what the AI may suggest.
 *  - 'execution': the case rules only (category, safety, return window, stale tracking). The
 *    guardrail-refusal and never-auto-recommend-coupon rules constrain the AI, not a human who
 *    explicitly requests an approval-gated action (CLAUDE.md D-049).
 */
export type RuleScope = 'recommendation' | 'execution';

/** Tools that can never be recommended (or, with scope 'execution', requested) for this case. */
export function blockedToolsForCase(
  ctx: CaseRuleContext,
  tools: Pick<ToolDefinition, 'toolName' | 'allowedCategories' | 'requiresHumanApproval'>[],
  scope: RuleScope = 'recommendation',
): Array<{ tool_name: string; rule: string; detail: string }> {
  const out: Array<{ tool_name: string; rule: string; detail: string }> = [];
  for (const t of tools) {
    const verdict = evaluateTool(t.toolName, ctx, t, scope);
    if (verdict) out.push({ tool_name: t.toolName, ...verdict });
  }
  return out;
}

function evaluateTool(
  name: string,
  ctx: CaseRuleContext,
  tool: Pick<ToolDefinition, 'toolName' | 'allowedCategories' | 'requiresHumanApproval'> | undefined,
  scope: RuleScope = 'recommendation',
): { rule: string; detail: string } | null {
  if (!tool) return { rule: 'unknown_tool', detail: `${name} is not in the tool catalog` };

  if (!tool.allowedCategories.includes(ctx.category)) {
    return {
      rule: 'category_not_allowed',
      detail: `${name} is allowed for [${tool.allowedCategories.join(', ')}], ticket category is ${ctx.category}`,
    };
  }

  if (scope === 'recommendation' && ctx.guardrailOutcome === 'refuse_and_escalate' && name !== ESCALATE_TOOL) {
    return { rule: 'guardrail_refusal', detail: 'guardrail outcome is refuse_and_escalate; only escalate_to_human is allowed' };
  }

  if (ctx.safetyCase && name !== ESCALATE_TOOL) {
    return {
      rule: 'safety_escalation_first',
      detail: 'product safety issue: specialist escalation and proof of purchase come before any replacement or coupon',
    };
  }

  if (
    ctx.category === 'refund' &&
    ctx.returnWindow &&
    !ctx.returnWindow.eligible &&
    (name === 'start_refund_review' || name === 'create_replacement_order')
  ) {
    return {
      rule: 'return_window_not_eligible',
      detail: `return window not eligible (${ctx.returnWindow.reason}); the draft must state the item is not eligible`,
    };
  }

  if (
    ctx.category === 'shipping' &&
    ctx.shipping?.staleTrackingUnderThreshold &&
    (name === 'create_replacement_order' || name === 'start_refund_review')
  ) {
    return {
      rule: 'stale_tracking_under_threshold',
      detail: `only ${ctx.shipping.businessDaysSinceDispatch} business days since dispatch (< ${STALE_TRACKING_RESOLUTION_BUSINESS_DAYS}) and no carrier confirmation; open_carrier_investigation only`,
    };
  }

  if (scope === 'recommendation' && name === 'issue_coupon') {
    return { rule: 'coupon_never_auto_recommended', detail: 'issue_coupon is never recommended by the system; a human may request it' };
  }

  return null;
}
