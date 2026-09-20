/**
 * Category prior: the one document that must be surfaced for a given triage category or topic.
 *
 * This is a deliberate reliability measure for citation coverage (CLAUDE.md D-027): when a
 * caller supplies a categoryHint, the prior document's best-matching chunk is guaranteed a slot
 * in the results and its score is boosted by +0.5. Retrieval is therefore not purely learned —
 * a known limitation that the README must state.
 */
export const CATEGORY_PRIORS: Readonly<Record<string, string>> = Object.freeze({
  // triage categories
  refund: 'KB-REFUND-001',
  shipping: 'KB-SHIPPING-001',
  warranty: 'KB-WARRANTY-001',
  billing: 'KB-BILLING-001',
  account_security: 'KB-ACCOUNT-001',
  general: 'KB-SECURITY-001',
  // topics
  coupon: 'KB-COUPON-001',
  guardrail: 'KB-SECURITY-001',
});

export const CATEGORY_PRIOR_BOOST = 0.5;

export function priorDocIdFor(categoryHint: string | undefined): string | null {
  if (!categoryHint) return null;
  return CATEGORY_PRIORS[categoryHint] ?? null;
}
