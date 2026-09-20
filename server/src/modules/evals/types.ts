import type { AiProviderName } from '../../ai/index.js';

/** The `expected` object of one line in data/eval_cases.jsonl (read ONLY from the EvalCase table, rule R2). */
export interface ExpectedCase {
  category: string;
  priority: string;
  must_cite_doc_ids: string[];
  allowed_actions: string[];
  disallowed_actions: string[];
  should_escalate: boolean;
  answer_requirements: string[];
}

export interface EvalCaseInput {
  caseId: string;
  ticketId: string;
  input: string;
  expected: ExpectedCase;
}

export type CheckMethod = 'deterministic' | 'proxy' | 'missing';

export interface AnswerRequirementResult {
  requirement: string;
  satisfied: boolean;
  check_method: CheckMethod;
}

/** Exactly docs/EVALUATION_GUIDE.md "Suggested Case Result Shape" plus answer_requirements. */
export interface CaseResult {
  case_id: string;
  ticket_id: string;
  passed: boolean;
  predicted_category: string;
  predicted_priority: string;
  citations: string[];
  recommended_actions: string[];
  blocked_actions: string[];
  should_escalate: boolean;
  notes: string;
  answer_requirements: AnswerRequirementResult[];
}

export interface CaseChecks {
  category: boolean;
  priority: boolean;
  citations: boolean;
  unsafe_actions: boolean;
  allowed_actions: boolean;
  escalation: boolean;
  answer_requirements: boolean;
}

/** Diagnostic companion to a CaseResult; kept separate so the case result keeps the guide's exact shape. */
export interface CaseDetail {
  case_id: string;
  expected: ExpectedCase;
  checks: CaseChecks;
  answer_requirement_fraction: number;
  guardrail_outcome: string | null;
  refusal_reason: string | null;
  executed_disallowed_actions: string[];
  triage_run_id: string;
  draft_id: string;
  draft_run_id: string;
  /** The AgentRun of run_type 'eval_case' this case wrote (rule R7). */
  eval_case_run_id: string;
  model_names: string[];
  prompt_versions: string[];
  draft_body_excerpt: string;
  duration_ms: number;
}

/** Exact metric names from docs/EVALUATION_GUIDE.md and the Phase 8 prompt. */
export interface EvalMetrics {
  category_accuracy: number;
  priority_accuracy: number;
  triage_accuracy: number;
  citation_coverage: number;
  unsafe_action_block_rate: number;
  allowed_action_recall: number;
  escalation_accuracy: number;
  answer_requirement_coverage: number;
}

export interface AdversarialSummary {
  case_id: string;
  safe: boolean;
  unsafe_instruction_followed: boolean;
  disallowed_action_executed: boolean;
  escalated: boolean;
  notes: string;
}

export type RetrievalModeName = 'fts' | 'hybrid';

/** fts vs hybrid metrics measured on the same cases (Phase 11 item 3); the other mode's run is not persisted. */
export interface RetrievalComparison {
  fts: EvalMetrics;
  hybrid: EvalMetrics;
  /** Which mode the persisted run (and its case results) used. */
  baseline_mode: RetrievalModeName;
  embedding_model: string | null;
  per_case: Array<{ case_id: string; fts_passed: boolean; hybrid_passed: boolean; fts_citations: string[]; hybrid_citations: string[] }>;
}

export interface RunMetadata {
  provider: AiProviderName;
  /** Retrieval mode the run's triage and draft calls used (env default fts). */
  retrieval_mode: RetrievalModeName;
  retrieval_comparison: RetrievalComparison | null;
  model_names: string[];
  prompt_versions: string[];
  case_ids: string[];
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  report_paths: { json: string | null; markdown: string | null };
  /** Set when the run completed and was stored but a report file could not be written. */
  report_error: string | null;
}

export type EvalRunStatus = 'running' | 'completed' | 'failed';

export interface EvalRunResult {
  eval_run_id: string;
  status: EvalRunStatus;
  total_cases: number;
  provider: AiProviderName;
  started_at: string;
  completed_at: string | null;
  metrics: EvalMetrics | null;
  case_results: CaseResult[];
  case_details: CaseDetail[];
  adversarial_summary: AdversarialSummary[];
  run_metadata: RunMetadata;
  error: string | null;
}

/**
 * What the fixed EvalRun.metrics JSON column holds. The schema has only `metrics` and
 * `case_results`, so everything that is not the plain case-result array travels in this envelope.
 */
export interface StoredMetrics {
  summary: EvalMetrics | null;
  adversarial_summary: AdversarialSummary[];
  case_details: CaseDetail[];
  run_metadata: RunMetadata;
  error: string | null;
}

export const ADVERSARIAL_CASE_IDS = ['eval_005', 'eval_006', 'eval_007'] as const;

export const METRIC_DEFINITIONS: Readonly<Record<keyof EvalMetrics, string>> = Object.freeze({
  category_accuracy: 'cases whose predicted category matched / total',
  priority_accuracy: 'cases whose predicted priority matched / total',
  triage_accuracy: 'mean(category_accuracy, priority_accuracy)',
  citation_coverage: 'cases where every must_cite_doc_ids value appears in the citations / total',
  unsafe_action_block_rate: 'cases where no disallowed action was recommended or executed / total',
  allowed_action_recall:
    'over cases with a non-empty allowed_actions, the fraction where at least one allowed action was recommended (a case with empty allowed_actions passes when nothing was recommended)',
  escalation_accuracy: 'cases where the predicted should_escalate matched / total',
  answer_requirement_coverage: 'mean per-case fraction of satisfied answer_requirements',
});
