import type { DocumentFinding } from './documentTrust.js';
import type { InputScanResult } from './inputScanner.js';
import type { PatternGroup } from './patterns.js';

export type GuardrailOutcome = 'allow' | 'allow_with_escalation' | 'refuse_and_escalate';

export interface GuardrailDecision {
  outcome: GuardrailOutcome;
  reasons: string[];
  /**
   * Citations ADDED to whatever retrieval produces. Extra citations are harmless because evals
   * check that the required ids are a subset of the answer's citations.
   */
  requiredCitations: string[];
  /** Which refusal template to use when outcome is refuse_and_escalate. */
  refusalTemplate: 'secret_disclosure_request' | 'identity_bypass_request' | 'injection_coupon_request' | null;
}

export interface GuardrailDecisionInput {
  inputScan: InputScanResult;
  documentFindings: DocumentFinding[];
  triage: { shouldEscalate: boolean; category?: string };
}

const OVERRIDE_GROUPS: PatternGroup[] = ['INSTRUCTION_OVERRIDE', 'CONCEALMENT', 'PRIVILEGE_ESCALATION'];

/**
 * Fixed decision table, evaluated top to bottom:
 *   SECRET_EXFIL (high)                                    -> refuse_and_escalate, [KB-SECURITY-001]
 *   IDENTITY_BYPASS (high)                                 -> refuse_and_escalate, [KB-ACCOUNT-001, KB-SECURITY-001]
 *   INSTRUCTION_OVERRIDE / CONCEALMENT / PRIVILEGE_ESCALATION with high severity
 *                                                          -> refuse_and_escalate, [KB-SECURITY-001]
 *   document findings only                                 -> allow_with_escalation (reasons list the doc ids)
 *   triage.shouldEscalate                                  -> allow_with_escalation
 *   otherwise                                              -> allow
 * PRIVILEGE_ESCALATION alone is low severity ("give me a coupon" is a request, not an attack)
 * and therefore does not refuse on its own.
 */
export function decideGuardrailOutcome(input: GuardrailDecisionInput): GuardrailDecision {
  const { inputScan, documentFindings, triage } = input;
  const has = (g: PatternGroup) => inputScan.categories.includes(g);
  const high = inputScan.severity === 'high';

  if (high && has('SECRET_EXFIL')) {
    return {
      outcome: 'refuse_and_escalate',
      reasons: ['secret_exfiltration_request', ...termReasons(inputScan, 'SECRET_EXFIL')],
      requiredCitations: ['KB-SECURITY-001'],
      refusalTemplate: 'secret_disclosure_request',
    };
  }

  if (high && has('IDENTITY_BYPASS')) {
    return {
      outcome: 'refuse_and_escalate',
      reasons: ['identity_bypass_request', ...termReasons(inputScan, 'IDENTITY_BYPASS')],
      requiredCitations: ['KB-ACCOUNT-001', 'KB-SECURITY-001'],
      refusalTemplate: 'identity_bypass_request',
    };
  }

  if (high && OVERRIDE_GROUPS.some(has)) {
    return {
      outcome: 'refuse_and_escalate',
      reasons: ['prompt_injection', ...OVERRIDE_GROUPS.filter(has).map((g) => g.toLowerCase())],
      requiredCitations: ['KB-SECURITY-001'],
      refusalTemplate: 'injection_coupon_request',
    };
  }

  const reasons: string[] = [];
  if (documentFindings.length > 0) {
    reasons.push(`untrusted_documents_rejected: ${[...new Set(documentFindings.map((f) => f.doc_id))].join(', ')}`);
  }
  if (triage.shouldEscalate) {
    reasons.push(`triage_escalation${triage.category ? `: ${triage.category}` : ''}`);
  }
  if (inputScan.flagged) {
    reasons.push(`low_severity_patterns: ${inputScan.categories.join(', ')}`);
  }

  if (documentFindings.length > 0 || triage.shouldEscalate) {
    return { outcome: 'allow_with_escalation', reasons, requiredCitations: [], refusalTemplate: null };
  }
  return { outcome: 'allow', reasons, requiredCitations: [], refusalTemplate: null };
}

function termReasons(scan: InputScanResult, group: PatternGroup): string[] {
  return scan.matches.filter((m) => m.group === group).map((m) => `${group.toLowerCase()}: "${m.term}"`);
}
