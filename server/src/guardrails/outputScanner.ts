import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';

export type OutputViolationCode =
  | 'LEAKED_SECRET'
  | 'LEAKED_INTERNAL_NOTE'
  | 'UNGROUNDED_CITATION'
  | 'MISSING_CITATION'
  | 'CROSS_CUSTOMER_DATA'
  | 'UNSAFE_PROMISE';

export interface OutputViolation {
  code: OutputViolationCode;
  severity: 'high' | 'low';
  detail: string;
}

export interface OutputScanInput {
  text: string;
  citations: string[];
  /** Doc ids actually retrieved (and passed as grounding) for this run. */
  allowedDocIds: string[];
  ticket: { ticketId: string; customerId: string };
  customer: { customerId: string; name: string; email: string };
}

export interface OutputScanResult {
  safe: boolean;
  violations: OutputViolation[];
}

// Injectable so the scanner is unit-testable without a database.
export interface OutputScanDeps {
  loadCustomers: () => Promise<Array<{ customerId: string; name: string; email: string }>>;
  loadInternalDocuments: () => Promise<Array<{ docId: string; audience: string; content: string }>>;
}

export const CUSTOMER_FACING_AUDIENCE = 'Customer support agents';

const HIGH: OutputViolationCode[] = ['LEAKED_SECRET', 'LEAKED_INTERNAL_NOTE', 'UNGROUNDED_CITATION', 'CROSS_CUSTOMER_DATA', 'UNSAFE_PROMISE'];
// MISSING_CITATION is low: it is recorded in the trace, and the draft pipeline appends the
// guardrail's required citations afterwards (CLAUDE.md D-039).

const SECRET_PHRASES = ['system prompt', 'hidden instructions'];
const TOKEN_LIKE = /sk-[A-Za-z0-9_-]{16,}/;
const POLICY_CLAIM = /\b(policy|eligible|within|days|warranty|refund|replacement)\b/i;
const UNSAFE_PROMISES = [
  'has been refunded',
  'have been refunded',
  'money is back',
  'refund is complete',
  'we have issued a coupon',
  'instantly replaced',
];
// A verbatim run of this many consecutive words from a non-customer-facing document counts as
// quoting "without paraphrase".
const VERBATIM_RUN_WORDS = 8;

const defaultDeps: OutputScanDeps = {
  loadCustomers: () => prisma.customer.findMany({ select: { customerId: true, name: true, email: true } }),
  loadInternalDocuments: () =>
    prisma.knowledgeDocument.findMany({
      where: { audience: { not: CUSTOMER_FACING_AUDIENCE } },
      select: { docId: true, audience: true, content: true },
    }),
};

/**
 * Post-generation scan of a draft reply (rule R8). A high-severity violation makes safe=false
 * and the caller must replace the body; the draft is never returned to the client as-is.
 */
export async function scanDraftOutput(input: OutputScanInput, deps: OutputScanDeps = defaultDeps): Promise<OutputScanResult> {
  const violations: OutputViolation[] = [];
  const text = input.text;
  const lower = text.toLowerCase();

  // LEAKED_SECRET — env values, the literal phrases, or a token-like string.
  const secrets = [env.OPENROUTER_API_KEY, env.DEMO_AGENT_TOKEN, env.DEMO_MANAGER_TOKEN, env.DEMO_ADMIN_TOKEN].filter(
    (s) => s && s.length >= 6,
  );
  for (const secret of secrets) {
    if (text.includes(secret)) violations.push(v('LEAKED_SECRET', `output contains a configured secret (${mask(secret)})`));
  }
  for (const phrase of SECRET_PHRASES) {
    if (lower.includes(phrase)) violations.push(v('LEAKED_SECRET', `output contains the phrase "${phrase}"`));
  }
  const tokenLike = TOKEN_LIKE.exec(text);
  if (tokenLike) violations.push(v('LEAKED_SECRET', `output contains a token-like string (${mask(tokenLike[0])})`));

  // LEAKED_INTERNAL_NOTE — verbatim quotes from non-customer-facing docs, or naming the adversarial doc.
  if (/KB-ADVERSARIAL-001/i.test(text)) {
    violations.push(v('LEAKED_INTERNAL_NOTE', 'output mentions KB-ADVERSARIAL-001'));
  }
  const internalDocs = await deps.loadInternalDocuments();
  for (const doc of internalDocs) {
    const run = longestSharedRun(doc.content, text);
    if (run >= VERBATIM_RUN_WORDS) {
      violations.push(v('LEAKED_INTERNAL_NOTE', `output quotes ${run} consecutive words from ${doc.docId} (audience: ${doc.audience})`));
    }
  }

  // UNGROUNDED_CITATION — a citation not in the retrieved set.
  const allowed = new Set(input.allowedDocIds);
  for (const c of input.citations) {
    if (!allowed.has(c)) violations.push(v('UNGROUNDED_CITATION', `citation ${c} was not retrieved for this run`));
  }

  // MISSING_CITATION — policy claim with no citations at all.
  if (input.citations.length === 0 && POLICY_CLAIM.test(text)) {
    violations.push({ code: 'MISSING_CITATION', severity: 'low', detail: 'draft makes a policy claim but cites nothing' });
  }

  // CROSS_CUSTOMER_DATA — another customer's name or email.
  const customers = await deps.loadCustomers();
  for (const other of customers) {
    if (other.customerId === input.customer.customerId) continue;
    if (other.name && lower.includes(other.name.toLowerCase())) {
      violations.push(v('CROSS_CUSTOMER_DATA', `output names another customer (${other.customerId})`));
    }
    if (other.email && lower.includes(other.email.toLowerCase())) {
      violations.push(v('CROSS_CUSTOMER_DATA', `output contains another customer's email (${other.customerId})`));
    }
  }

  // UNSAFE_PROMISE — claims that money moved or an action already happened.
  for (const phrase of UNSAFE_PROMISES) {
    if (lower.includes(phrase)) violations.push(v('UNSAFE_PROMISE', `output says "${phrase}"`));
  }

  return { safe: !violations.some((x) => x.severity === 'high'), violations };
}

function v(code: OutputViolationCode, detail: string): OutputViolation {
  return { code, severity: HIGH.includes(code) ? 'high' : 'low', detail };
}

function mask(s: string): string {
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

// Longest run of consecutive words shared between `source` and `output`.
export function longestSharedRun(source: string, output: string): number {
  const a = words(source);
  const b = words(output);
  if (a.length === 0 || b.length === 0) return 0;
  const grams = new Set<string>();
  for (let i = 0; i + VERBATIM_RUN_WORDS <= a.length; i += 1) {
    grams.add(a.slice(i, i + VERBATIM_RUN_WORDS).join(' '));
  }
  let best = 0;
  for (let i = 0; i + VERBATIM_RUN_WORDS <= b.length; i += 1) {
    if (!grams.has(b.slice(i, i + VERBATIM_RUN_WORDS).join(' '))) continue;
    // Extend the match forward to report the true run length.
    let len = VERBATIM_RUN_WORDS;
    while (i + len < b.length && grams.has(b.slice(i + len - VERBATIM_RUN_WORDS + 1, i + len + 1).join(' '))) len += 1;
    best = Math.max(best, len);
  }
  return best;
}
