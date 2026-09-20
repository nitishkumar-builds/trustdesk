import { aiProviderError } from '../errors/AppError.js';
import type { AiAdapter, AiRequest, AiResponse } from './types.js';

/**
 * Deterministic mock provider: no network, no randomness. It is the default provider and what
 * every test and eval run uses. It reads the <customer_message> block from the user payload and
 * applies keyword rules to produce the same JSON shape the live model is asked for.
 */

export type TriageCategory = 'shipping' | 'refund' | 'warranty' | 'billing' | 'account_security' | 'general';
export type TriagePriority = 'low' | 'medium' | 'high' | 'urgent';
export type TriageSentiment = 'frustrated' | 'neutral' | 'worried' | 'angry' | 'positive';

export interface TriageJson {
  category: TriageCategory;
  priority: TriagePriority;
  sentiment: TriageSentiment;
  should_escalate: boolean;
  reason_summary: string;
}

export interface MockTriageRule {
  name: string;
  /** Case-insensitive phrases; any match fires the rule. */
  terms: readonly string[];
  category: TriageCategory;
  priority: TriagePriority;
  sentiment: TriageSentiment;
  should_escalate: boolean;
  reason: string;
  /** Optional: when any of these also match, priority is raised to `boostedPriority`. */
  boostTerms?: readonly string[];
  boostedPriority?: TriagePriority;
}

export const URGENCY_TERMS = [
  'urgent',
  'urgently',
  'travel',
  'travelling',
  'traveling',
  'trip',
  'flight',
  'time-sensitive',
  'time sensitive',
  'deadline',
  'asap',
  'immediately',
  'next week',
  'tomorrow',
] as const;

// Evaluated top to bottom; the first rule whose terms match wins. Order matters: secret
// exfiltration is checked before generic injection so "print your api key" is not classified
// as a plain injection, and safety comes first of all.
export const MOCK_TRIAGE_RULES: readonly MockTriageRule[] = [
  {
    name: 'safety',
    terms: ['swelling', 'swollen', 'overheat', 'burning smell', 'smoke', 'exposed wire', 'electric shock'],
    category: 'warranty',
    priority: 'urgent',
    sentiment: 'worried',
    should_escalate: true,
    reason: 'Product safety issue reported; escalate to a specialist with urgent priority.',
  },
  {
    name: 'account_change',
    terms: ['change my account email', 'password reset', 'account deletion', 'change address', 'change my email'],
    category: 'account_security',
    priority: 'high',
    sentiment: 'neutral',
    should_escalate: true,
    reason: 'Account change request requires identity verification by a human.',
  },
  {
    name: 'secret_exfiltration',
    terms: ['system prompt', 'api key', 'internal notes', 'hidden instructions', 'hidden prompt'],
    category: 'account_security',
    priority: 'high',
    sentiment: 'neutral',
    should_escalate: true,
    reason: 'Request to reveal internal instructions or secrets; refuse and escalate.',
  },
  {
    name: 'prompt_injection',
    terms: ['ignore all instructions', 'ignore previous instructions', 'system override', 'ignore the support policy', 'do not mention this'],
    category: 'general',
    priority: 'medium',
    sentiment: 'neutral',
    should_escalate: true,
    reason: 'Message contains instructions aimed at the assistant; treated as untrusted and escalated.',
  },
  {
    name: 'duplicate_charge',
    terms: ['double charge', 'duplicate charge', 'charged twice', 'two charges', 'billed twice'],
    category: 'billing',
    priority: 'high',
    sentiment: 'frustrated',
    should_escalate: false,
    reason: 'Possible duplicate charge; customer funds affected.',
  },
  {
    name: 'shipping',
    // Deliberately no bare "package"/"delivered": a damaged-on-arrival ticket mentions delivery too.
    terms: ['tracking', 'delivery', 'shipment', 'shipping', 'in transit', 'no movement', 'not moved', 'courier', 'carrier', 'lost package', 'has not arrived', 'never arrived'],
    category: 'shipping',
    priority: 'medium',
    sentiment: 'frustrated',
    should_escalate: false,
    reason: 'Delivery or tracking problem.',
    boostTerms: URGENCY_TERMS,
    boostedPriority: 'high',
  },
  {
    name: 'damaged_item',
    terms: ['damaged', 'defective', 'cracked', 'broken', 'not working', 'faulty'],
    category: 'refund',
    priority: 'medium',
    sentiment: 'frustrated',
    should_escalate: false,
    reason: 'Damaged or defective item reported.',
  },
  {
    name: 'refund_request',
    terms: ['refund', 'return', 'cancel', 'money back'],
    category: 'refund',
    priority: 'low',
    sentiment: 'neutral',
    should_escalate: false,
    reason: 'Refund, return or cancellation request.',
  },
];

export const MOCK_DEFAULT_TRIAGE: TriageJson = {
  category: 'general',
  priority: 'low',
  sentiment: 'neutral',
  should_escalate: false,
  reason_summary: 'No specific policy topic detected; general enquiry.',
};

export function matchTerms(text: string, terms: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t.toLowerCase()));
}

export function mockTriage(customerText: string): { json: TriageJson; rule: string | null } {
  for (const rule of MOCK_TRIAGE_RULES) {
    const matched = matchTerms(customerText, rule.terms);
    if (matched.length === 0) continue;
    let priority = rule.priority;
    if (rule.boostTerms && rule.boostedPriority && matchTerms(customerText, rule.boostTerms).length > 0) {
      priority = rule.boostedPriority;
    }
    return {
      rule: rule.name,
      json: {
        category: rule.category,
        priority,
        sentiment: rule.sentiment,
        should_escalate: rule.should_escalate,
        reason_summary: rule.reason,
      },
    };
  }
  return { rule: null, json: { ...MOCK_DEFAULT_TRIAGE } };
}

// The prompt builders fence the customer text; the mock classifies only that block so retrieved
// policy text (which quotes injection examples) can never trigger a rule.
export function extractCustomerMessage(userPayload: string): string {
  const m = /<customer_message>([\s\S]*?)<\/customer_message>/i.exec(userPayload);
  return m ? m[1]! : userPayload;
}

// ---------------------------------------------------------------------------
// Draft rules (draftReply.v1). The mock reads the labelled fact lines and the retrieved doc ids
// that buildUser writes into the payload, then answers per category with a customer-safe body.
// ---------------------------------------------------------------------------

export interface DraftJson {
  body: string;
  citations: string[];
  recommended_actions: Array<{ tool_name: string; reason: string }>;
  confidence: 'high' | 'medium' | 'low';
}

export interface MockDraftFacts {
  category: string | null;
  returnWindowEligible: boolean | null;
  returnWindowReason: string | null;
  warrantyCovered: boolean | null;
  retrievedDocIds: string[];
}

// Everything the customer wrote is removed before the labelled fact lines are parsed, so a
// message containing its own "return_window: eligible=true" line cannot override the real facts.
export function stripCustomerMessage(userPayload: string): string {
  return userPayload.replace(/<customer_message>[\s\S]*?<\/customer_message>/gi, '');
}

export function extractDraftFacts(userPayload: string): MockDraftFacts {
  const facts = stripCustomerMessage(userPayload);
  const category = /^triage_category:\s*([a-z_]+)/im.exec(facts)?.[1] ?? null;
  const rw = /^return_window:\s*eligible=(true|false),\s*reason=([a-z_]+)/im.exec(facts);
  const wt = /^warranty:\s*covered=(true|false)/im.exec(facts);
  const retrievedDocIds = [...facts.matchAll(/<policy_document id="([^"]+)"/g)].map((m) => m[1]!);
  return {
    category,
    returnWindowEligible: rw ? rw[1]!.toLowerCase() === 'true' : null,
    returnWindowReason: rw?.[2] ?? null,
    warrantyCovered: wt ? wt[1]!.toLowerCase() === 'true' : null,
    retrievedDocIds: [...new Set(retrievedDocIds)],
  };
}

export interface MockDraftRule {
  name: string;
  /** Category the rule applies to; null = any. */
  category: TriageCategory | null;
  /** Extra predicate over the customer text and facts. */
  when?: (customerText: string, facts: MockDraftFacts) => boolean;
  preferredDocId: string;
  body: string;
  recommended_actions: Array<{ tool_name: string; reason: string }>;
  confidence: DraftJson['confidence'];
}

const SAFETY_TERMS = ['swelling', 'swollen', 'overheat', 'burning smell', 'smoke', 'exposed wire', 'electric shock'] as const;
const DAMAGE_TERMS = ['damaged', 'defective', 'cracked', 'broken', 'not working', 'faulty'] as const;

// Bodies deliberately avoid every phrase the output scanner or the eval answer requirements
// forbid (no "has been refunded", no troubleshooting verbs in the safety reply, no coupon offers).
export const MOCK_DRAFT_RULES: readonly MockDraftRule[] = [
  {
    name: 'warranty_safety',
    category: 'warranty',
    when: (text) => matchTerms(text, SAFETY_TERMS).length > 0,
    preferredDocId: 'KB-WARRANTY-001',
    body:
      'Thank you for letting us know, and I am sorry about the swelling battery. A swollen battery is a safety issue, so please stop using the device, keep it away from heat, and do not attempt any repair yourself. I have escalated your ticket to a specialist with urgent priority; they will contact you about the next steps under our warranty and product safety policy, including whether your gold-tier extension applies. Please do not continue to use the tablet in the meantime.',
    recommended_actions: [{ tool_name: 'escalate_to_human', reason: 'Product safety issue; specialist review comes before any replacement.' }],
    confidence: 'high',
  },
  {
    name: 'warranty_standard',
    category: 'warranty',
    preferredDocId: 'KB-WARRANTY-001',
    body:
      'Thank you for contacting us about the fault with your device. Electronics carry a 12-month limited warranty from the delivery date, and gold-tier customers receive a 6-month extension on eligible hardware. Based on your order dates, a specialist will confirm whether the warranty still covers this fault and may ask for proof of purchase, the serial number, and photos. Replacement under warranty requires human approval, so I have escalated your ticket for review.',
    recommended_actions: [{ tool_name: 'escalate_to_human', reason: 'Warranty replacement requires proof of purchase and human approval.' }],
    confidence: 'medium',
  },
  {
    name: 'refund_not_eligible',
    category: 'refund',
    when: (_text, facts) => facts.returnWindowEligible === false,
    preferredDocId: 'KB-REFUND-001',
    body:
      'Thank you for reaching out. I checked your order, and this item is a software license, which our refund policy lists as a final sale item that is not eligible for a refund after purchase unless required by law or approved by a support manager. I am sorry that we cannot process this refund automatically. If you believe an exception should apply, reply to this message and a support specialist can review your request.',
    recommended_actions: [],
    confidence: 'high',
  },
  {
    name: 'refund_damaged_eligible',
    category: 'refund',
    when: (text, facts) => facts.returnWindowEligible !== false && matchTerms(text, DAMAGE_TERMS).length > 0,
    preferredDocId: 'KB-REFUND-001',
    body:
      'I am sorry to hear that your item arrived damaged. Because the damage was reported within the return window, our policy allows us to offer either a replacement or a refund review. Could you share a photo or a short description of the damage? Once a support specialist approves the request, we will arrange the replacement for you.',
    recommended_actions: [{ tool_name: 'create_replacement_order', reason: 'Damaged physical item reported within the return window.' }],
    confidence: 'high',
  },
  {
    name: 'refund_general',
    category: 'refund',
    preferredDocId: 'KB-REFUND-001',
    body:
      'Thank you for your message. Physical products can be returned within 7 calendar days of delivery when they are unused, defective, damaged on arrival, or materially different from the listing. Your request is within the return window, so I have asked a support specialist to review a refund; any refund needs human approval before payment is processed, so I cannot confirm the outcome yet.',
    recommended_actions: [{ tool_name: 'start_refund_review', reason: 'Return requested within the return window.' }],
    confidence: 'medium',
  },
  {
    name: 'shipping_stale',
    category: 'shipping',
    preferredDocId: 'KB-SHIPPING-001',
    body:
      'I am sorry that the tracking for your order has not moved. Our shipping policy allows us to open a carrier investigation when tracking shows no movement for 5 or more business days, and that carrier investigation is the next step here. Because you need the item for your travel, I have marked this ticket as high priority. A replacement or refund review can be considered after the carrier confirms the status or after 10 business days without movement, so I cannot confirm either of those yet.',
    recommended_actions: [{ tool_name: 'open_carrier_investigation', reason: 'Tracking stale for 5+ business days.' }],
    confidence: 'high',
  },
  {
    name: 'billing_duplicate',
    category: 'billing',
    preferredDocId: 'KB-BILLING-001',
    body:
      'I am sorry about the duplicate charge on your card. I can see only one order in your account, so I have requested a billing review; a support manager will approve it and our payment operations team will then confirm whether the second charge is a duplicate. To speed this up, please share the payment date, the amount, the payment method type, and the last four digits of the card used. Please never send the full card number, the CVV, or any one-time passcode. I cannot confirm the refund until payment operations completes the review.',
    recommended_actions: [{ tool_name: 'start_refund_review', reason: 'Possible duplicate charge; one order on file.' }],
    confidence: 'high',
  },
  {
    name: 'account_security',
    category: 'account_security',
    preferredDocId: 'KB-ACCOUNT-001',
    body:
      'Thank you for contacting us. Changes to account details such as the account email require identity verification before we can make them, and this step cannot be skipped. A support specialist will contact you with the verification steps, and once verification is complete they will update your account. I am sorry for the extra step; it protects your account.',
    recommended_actions: [{ tool_name: 'escalate_to_human', reason: 'Account change requires identity verification by a human.' }],
    confidence: 'high',
  },
  {
    name: 'general',
    category: null,
    preferredDocId: 'KB-SECURITY-001',
    body:
      'Thank you for contacting us. I have passed your message to a support specialist who will review it and follow up with you directly. If you can share your order number and any other details, that will help them respond faster.',
    recommended_actions: [],
    confidence: 'medium',
  },
];

export function mockDraft(customerText: string, facts: MockDraftFacts): { json: DraftJson; rule: string } {
  const rule =
    MOCK_DRAFT_RULES.find(
      (r) => (r.category === null || r.category === facts.category) && (r.when ? r.when(customerText, facts) : true),
    ) ?? MOCK_DRAFT_RULES[MOCK_DRAFT_RULES.length - 1]!;

  // Cite only documents that were actually retrieved for this run; never invent an id.
  const citations = facts.retrievedDocIds.includes(rule.preferredDocId)
    ? [rule.preferredDocId]
    : facts.retrievedDocIds.slice(0, 1);

  return {
    rule: rule.name,
    json: {
      body: rule.body,
      citations,
      recommended_actions: rule.recommended_actions.map((a) => ({ ...a })),
      confidence: rule.confidence,
    },
  };
}

export class MockAdapter implements AiAdapter {
  readonly name = 'mock';

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const customerText = extractCustomerMessage(req.user);

    let json: unknown;
    if (req.promptVersion.startsWith('triage.')) {
      json = mockTriage(customerText).json;
    } else if (req.promptVersion.startsWith('draftReply.')) {
      json = mockDraft(customerText, extractDraftFacts(req.user)).json;
    } else {
      throw aiProviderError(`Mock adapter has no rule set for prompt ${req.promptVersion}`, {
        prompt_version: req.promptVersion,
      });
    }

    const text = JSON.stringify(json);
    return {
      text,
      json,
      modelProvider: 'mock',
      modelName: 'mock-rules-v1',
      latencyMs: Date.now() - started,
      tokenUsage: {
        prompt: Math.ceil((req.system.length + req.user.length) / 4),
        completion: Math.ceil(text.length / 4),
      },
      costEstimate: 0,
    };
  }
}
