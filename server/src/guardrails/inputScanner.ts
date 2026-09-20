import { findMatches, HIGH_SEVERITY_GROUPS, type PatternGroup } from './patterns.js';

export type UntrustedSource = 'customer_message' | 'retrieved_document';
export type ScanSeverity = 'none' | 'low' | 'high';

export interface InputScanResult {
  source: UntrustedSource;
  flagged: boolean;
  categories: PatternGroup[];
  matches: Array<{ group: PatternGroup; term: string }>;
  severity: ScanSeverity;
}

/**
 * Classifies untrusted text against the pattern groups. It never rewrites the text: the
 * original customer body is always preserved for auditability (rule R3).
 * Severity is 'high' when INSTRUCTION_OVERRIDE, SECRET_EXFIL, IDENTITY_BYPASS or CONCEALMENT
 * match, 'low' for the remaining groups, 'none' when nothing matches.
 */
export function scanUntrustedInput(text: string, source: UntrustedSource): InputScanResult {
  const subject = source === 'retrieved_document' ? stripQuotedMentions(text) : text;
  const matches = findMatches(subject);
  const categories = [...new Set(matches.map((m) => m.group))];
  const severity: ScanSeverity =
    categories.length === 0 ? 'none' : categories.some((c) => HIGH_SEVERITY_GROUPS.has(c)) ? 'high' : 'low';
  return { source, flagged: matches.length > 0, categories, matches, severity };
}

/**
 * Documents only: a phrase inside quotation marks is a *mention* (KB-SECURITY-001 lists
 * injection examples such as "Ignore previous instructions."), not an instruction to the
 * assistant. Quoted spans are blanked before pattern matching. Customer messages are never
 * given this exemption (CLAUDE.md D-037).
 */
export function stripQuotedMentions(text: string): string {
  return text.replace(/"[^"\n]{1,200}"|“[^”\n]{1,200}”/g, (m) => ' '.repeat(m.length));
}
