import { URGENCY_TERMS, matchTerms, type TriageJson, type TriagePriority } from '../../ai/mockAdapter.js';

/**
 * Deterministic post-rules that override the model. Safety and security decisions must not
 * depend on model mood. PR1–PR4 set category/priority/escalation and are mutually exclusive:
 * the first one that matches is applied; later matches are still recorded (applied: false) so
 * the trace shows every pattern that was present. PR5–PR6 only raise priority.
 */

export interface FiredRule {
  rule: string;
  matched_terms: string[];
  applied: boolean;
}

const SAFETY_TERMS = ['swelling', 'swollen', 'overheat', 'burning smell', 'smoke', 'exposed wire', 'electric shock'] as const;

const ACCOUNT_CHANGE_TERMS = ['change my account email', 'change my email', 'password reset', 'reset my password', 'account deletion', 'delete my account', 'change address', 'change my address'] as const;

const IDENTITY_BYPASS_TERMS = ['ignore identity', 'skip identity', 'skip verification', 'skip the verification', 'no need to verify', 'bypass verification', 'without verification', 'ignore verification'] as const;

const SECRET_EXFIL_TERMS = ['system prompt', 'hidden instructions', 'hidden prompt', 'api key', 'secret key', 'secrets', 'internal notes', 'internal-only', 'internal instructions'] as const;

const INJECTION_TERMS = ['ignore all instructions', 'ignore previous instructions', 'ignore the above', 'disregard the above', 'system override', 'ignore the support policy', 'you are now allowed', 'do not mention this', 'the policy has changed', 'new instructions'] as const;

const BILLING_TERMS = ['double charge', 'duplicate charge', 'charged twice', 'two charges', 'billed twice'] as const;

const PRIORITY_RANK: Record<TriagePriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

export function atLeast(current: TriagePriority, floor: TriagePriority): TriagePriority {
  return PRIORITY_RANK[current] >= PRIORITY_RANK[floor] ? current : floor;
}

export function applyPostRules(customerText: string, model: TriageJson): { result: TriageJson; fired: FiredRule[] } {
  const result: TriageJson = { ...model };
  const fired: FiredRule[] = [];
  let categoryDecided = false;

  const decide = (rule: string, matched: string[], apply: () => void) => {
    if (matched.length === 0) return;
    const applied = !categoryDecided;
    if (applied) {
      apply();
      categoryDecided = true;
    }
    fired.push({ rule, matched_terms: matched, applied });
  };

  // PR1 Safety
  decide('PR1_safety', matchTerms(customerText, SAFETY_TERMS), () => {
    result.category = 'warranty';
    result.priority = 'urgent';
    result.should_escalate = true;
    result.reason_summary = `Product safety issue reported (${firstTerm(customerText, SAFETY_TERMS)}); do not troubleshoot, escalate to a specialist urgently.`;
  });

  // PR2 Account change or identity bypass
  const accountMatches = [...matchTerms(customerText, ACCOUNT_CHANGE_TERMS), ...matchTerms(customerText, IDENTITY_BYPASS_TERMS)];
  decide('PR2_account_change_or_identity_bypass', accountMatches, () => {
    result.category = 'account_security';
    result.priority = atLeast(result.priority, 'high');
    result.should_escalate = true;
    result.reason_summary = 'Account change or identity-check bypass requested; verification by a human is required.';
  });

  // PR3 Secret exfiltration
  decide('PR3_secret_exfiltration', matchTerms(customerText, SECRET_EXFIL_TERMS), () => {
    result.category = 'account_security';
    result.priority = atLeast(result.priority, 'high');
    result.should_escalate = true;
    result.reason_summary = 'Request to reveal system prompts, keys or internal notes; refuse and escalate.';
  });

  // PR4 Prompt injection without a secret request
  decide('PR4_prompt_injection', matchTerms(customerText, INJECTION_TERMS), () => {
    result.category = 'general';
    result.priority = atLeast(result.priority, 'medium');
    result.should_escalate = true;
    result.reason_summary = 'Message contains instructions aimed at the assistant; treated as untrusted and escalated.';
  });

  // PR5 Shipping urgency
  if (result.category === 'shipping') {
    const urgency = matchTerms(customerText, URGENCY_TERMS);
    if (urgency.length > 0) {
      result.priority = atLeast(result.priority, 'high');
      fired.push({ rule: 'PR5_shipping_urgency', matched_terms: urgency, applied: true });
    }
  }

  // PR6 Billing funds impact
  if (result.category === 'billing') {
    result.priority = atLeast(result.priority, 'high');
    fired.push({
      rule: 'PR6_billing_funds_impact',
      matched_terms: matchTerms(customerText, BILLING_TERMS),
      applied: true,
    });
  }

  return { result, fired };
}

function firstTerm(text: string, terms: readonly string[]): string {
  return matchTerms(text, terms)[0] ?? terms[0]!;
}
