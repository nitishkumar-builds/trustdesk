// Red-team view (Phase 11 item 5): the flagged AgentRuns and a stateless probe that runs the input
// scanner, the deterministic post-rules and the guardrail decision over arbitrary text without
// touching a ticket or writing a row.
import { prisma } from '../../db/prisma.js';
import { scanUntrustedInput, type InputScanResult } from '../../guardrails/inputScanner.js';
import { decideGuardrailOutcome } from '../../guardrails/policy.js';
import { refusalBody } from '../../guardrails/refusalTemplates.js';
import { applyPostRules, type FiredRule } from '../../modules/triage/postRules.js';

export interface ProbeResult {
  input_scan: InputScanResult;
  fired_rules: FiredRule[];
  decision: { outcome: string; reasons: string[]; required_citations: string[]; refusal_template: string | null };
  /** The fixed reply the draft pipeline would send instead of calling a model, when the outcome refuses. */
  refusal_preview: string | null;
  would_call_model: boolean;
  persisted: false;
}

// A neutral model answer: the probe shows what the deterministic layers alone decide.
const NEUTRAL_TRIAGE = { category: 'general', priority: 'low', sentiment: 'neutral', should_escalate: false, reason_summary: 'probe' } as const;

export function probeText(text: string): ProbeResult {
  const inputScan = scanUntrustedInput(text, 'customer_message');
  const { result, fired } = applyPostRules(text, { ...NEUTRAL_TRIAGE });
  const decision = decideGuardrailOutcome({ inputScan, documentFindings: [], triage: { shouldEscalate: result.should_escalate, category: result.category } });
  return {
    input_scan: inputScan,
    fired_rules: fired,
    decision: { outcome: decision.outcome, reasons: decision.reasons, required_citations: decision.requiredCitations, refusal_template: decision.refusalTemplate },
    refusal_preview: decision.refusalTemplate ? refusalBody(decision.refusalTemplate) : null,
    would_call_model: decision.outcome !== 'refuse_and_escalate',
    persisted: false,
  };
}

export interface FlaggedRunDto {
  run_id: string;
  ticket_id: string | null;
  run_type: string;
  status: string;
  created_at: string;
  severity: string;
  pattern_groups: string[];
  matched_terms: Array<{ group: string; term: string }>;
  outcome: string | null;
  refusal_template: string | null;
  model_provider: string | null;
}

interface StoredScan {
  input_scan?: { flagged?: boolean; severity?: string; categories?: string[]; matches?: Array<{ group: string; term: string }> };
  decision?: { outcome?: string; refusal_template?: string | null; refusalTemplate?: string | null };
}

/** Every AgentRun whose stored guardrail_results carry a flagged input scan (draft runs), newest first. */
export async function listFlaggedRuns(limit: number, offset = 0): Promise<{ items: FlaggedRunDto[]; total: number; limit: number; offset: number }> {
  const where = { guardrailResults: { path: ['input_scan', 'flagged'], equals: true } };
  const [rows, total] = await Promise.all([
    prisma.agentRun.findMany({ where, orderBy: [{ createdAt: 'desc' }, { runId: 'asc' }], take: limit, skip: offset }),
    prisma.agentRun.count({ where }),
  ]);
  return {
    limit,
    offset,
    items: rows.map((r) => {
      const g = (r.guardrailResults ?? {}) as StoredScan;
      return {
        run_id: r.runId,
        ticket_id: r.ticketId,
        run_type: r.runType,
        status: r.status,
        created_at: r.createdAt.toISOString(),
        severity: g.input_scan?.severity ?? 'unknown',
        pattern_groups: g.input_scan?.categories ?? [],
        matched_terms: g.input_scan?.matches ?? [],
        outcome: g.decision?.outcome ?? null,
        refusal_template: g.decision?.refusal_template ?? g.decision?.refusalTemplate ?? null,
        model_provider: r.modelProvider,
      };
    }),
    total,
  };
}
