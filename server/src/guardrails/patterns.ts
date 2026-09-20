/**
 * Guardrail pattern groups, kept as data (not buried regex) so they are readable, testable and
 * easy to extend. Matching is case-insensitive and whole-phrase (word boundaries, flexible
 * whitespace) — see `compilePattern`. Used by the input scanner (customer messages, retrieved
 * documents), the ingest-time quarantine and the output scanner.
 */

export type PatternGroup =
  | 'INSTRUCTION_OVERRIDE'
  | 'SECRET_EXFIL'
  | 'CONCEALMENT'
  | 'IDENTITY_BYPASS'
  | 'PRIVILEGE_ESCALATION'
  | 'PII_REQUEST';

export const PATTERN_GROUPS: Readonly<Record<PatternGroup, readonly string[]>> = Object.freeze({
  INSTRUCTION_OVERRIDE: [
    'ignore all instructions',
    'ignore previous instructions',
    'ignore all previous instructions',
    'ignore all previous policies',
    'ignore the support policy',
    'disregard the above',
    'system override',
    'you are now allowed',
    'the policy has changed',
    'new instructions',
  ],
  SECRET_EXFIL: [
    'system prompt',
    'hidden prompt',
    'hidden instructions',
    'api key',
    'secret key',
    'access token',
    'internal notes',
    'internal-only',
    'print your',
  ],
  CONCEALMENT: [
    'do not mention',
    "don't tell the human",
    'do not tell the human',
    'hide this from',
    'keep this between us',
    'do not log',
  ],
  IDENTITY_BYPASS: [
    'ignore identity',
    'skip identity',
    'skip verification',
    'no need to verify',
    'bypass verification',
  ],
  PRIVILEGE_ESCALATION: [
    'approve every refund',
    'approve all refunds',
    'issue me a coupon',
    'issue me a * coupon',
    'give me a coupon',
    'give me a * coupon',
    'unlimited discount',
  ],
  PII_REQUEST: [
    'other customers',
    'all customer emails',
    'customer list',
    'full card number',
    'cvv',
    'otp',
    'banking password',
  ],
});

// Groups whose presence alone makes an input high severity.
export const HIGH_SEVERITY_GROUPS: ReadonlySet<PatternGroup> = new Set([
  'INSTRUCTION_OVERRIDE',
  'SECRET_EXFIL',
  'IDENTITY_BYPASS',
  'CONCEALMENT',
]);

// Groups that make a retrieved document untrusted (rule R4 family).
export const DOCUMENT_REJECT_GROUPS: ReadonlySet<PatternGroup> = new Set(['INSTRUCTION_OVERRIDE', 'CONCEALMENT']);

export interface CompiledPattern {
  group: PatternGroup;
  term: string;
  regex: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-phrase: no letter/digit on either side, any run of whitespace between words. A '*'
// token matches up to WILDCARD_MAX_WORDS intervening words ("issue me a * coupon").
const WILDCARD_MAX_WORDS = 4;

export function compilePattern(group: PatternGroup, term: string): CompiledPattern {
  const tokens = term.split(/\s+/);
  const parts: string[] = [];
  tokens.forEach((tok, i) => {
    if (tok === '*') {
      // whitespace, then zero or more whole words each followed by whitespace
      parts.push(`\\s+(?:\\S+\\s+){0,${WILDCARD_MAX_WORDS}}?`);
      return;
    }
    if (i > 0 && tokens[i - 1] !== '*') parts.push('\\s+');
    parts.push(escapeRegex(tok));
  });
  const body = parts.join('');
  return { group, term, regex: new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu') };
}

export const COMPILED_PATTERNS: readonly CompiledPattern[] = (
  Object.keys(PATTERN_GROUPS) as PatternGroup[]
).flatMap((group) => PATTERN_GROUPS[group].map((term) => compilePattern(group, term)));

export function findMatches(text: string, groups?: ReadonlySet<PatternGroup>): Array<{ group: PatternGroup; term: string }> {
  const out: Array<{ group: PatternGroup; term: string }> = [];
  for (const p of COMPILED_PATTERNS) {
    if (groups && !groups.has(p.group)) continue;
    if (p.regex.test(text)) out.push({ group: p.group, term: p.term });
  }
  return out;
}
