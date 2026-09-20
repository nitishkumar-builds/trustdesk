import type { EvalRun } from '@prisma/client';
import type { AiProviderName } from '../../ai/index.js';
import type { CaseResult, EvalRunResult, EvalRunStatus, StoredMetrics } from './types.js';

/** docs/API_CONTRACT.md section 11 example fields, flattened next to the full results. */
export interface EvalRunDto extends EvalRunResult {
  triage_accuracy: number | null;
  citation_coverage: number | null;
  unsafe_action_block_rate: number | null;
  escalation_accuracy: number | null;
}

export interface EvalRunSummaryDto {
  eval_run_id: string;
  status: EvalRunStatus;
  provider: AiProviderName;
  total_cases: number;
  started_at: string;
  completed_at: string | null;
  metrics: EvalRunResult['metrics'];
  error: string | null;
}

export function emptyStoredMetrics(provider: AiProviderName, caseIds: string[], startedAt: Date): StoredMetrics {
  return {
    summary: null,
    adversarial_summary: [],
    case_details: [],
    run_metadata: {
      provider,
      retrieval_mode: 'fts',
      retrieval_comparison: null,
      model_names: [],
      prompt_versions: [],
      case_ids: caseIds,
      started_at: startedAt.toISOString(),
      completed_at: null,
      duration_ms: null,
      report_paths: { json: null, markdown: null },
      report_error: null,
    },
    error: null,
  };
}

function storedMetrics(row: EvalRun): StoredMetrics {
  const raw = (row.metrics ?? {}) as Partial<StoredMetrics>;
  const fallback = emptyStoredMetrics(row.provider as AiProviderName, [], row.startedAt);
  return {
    summary: raw.summary ?? null,
    adversarial_summary: raw.adversarial_summary ?? [],
    case_details: raw.case_details ?? [],
    run_metadata: { ...fallback.run_metadata, ...(raw.run_metadata ?? {}) },
    error: raw.error ?? null,
  };
}

export function statusOf(row: EvalRun): EvalRunStatus {
  const stored = storedMetrics(row);
  if (stored.error) return 'failed';
  return row.completedAt ? 'completed' : 'running';
}

export function mapEvalRunResult(row: EvalRun): EvalRunResult {
  const stored = storedMetrics(row);
  return {
    eval_run_id: row.evalRunId,
    status: statusOf(row),
    total_cases: row.totalCases,
    provider: row.provider as AiProviderName,
    started_at: row.startedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
    metrics: stored.summary,
    case_results: Array.isArray(row.caseResults) ? (row.caseResults as unknown as CaseResult[]) : [],
    case_details: stored.case_details,
    adversarial_summary: stored.adversarial_summary,
    run_metadata: stored.run_metadata,
    error: stored.error,
  };
}

export function mapEvalRun(row: EvalRun): EvalRunDto {
  const result = mapEvalRunResult(row);
  return {
    ...result,
    triage_accuracy: result.metrics?.triage_accuracy ?? null,
    citation_coverage: result.metrics?.citation_coverage ?? null,
    unsafe_action_block_rate: result.metrics?.unsafe_action_block_rate ?? null,
    escalation_accuracy: result.metrics?.escalation_accuracy ?? null,
  };
}

export function mapEvalRunSummary(row: EvalRun): EvalRunSummaryDto {
  const result = mapEvalRunResult(row);
  return {
    eval_run_id: result.eval_run_id,
    status: result.status,
    provider: result.provider,
    total_cases: result.total_cases,
    started_at: result.started_at,
    completed_at: result.completed_at,
    metrics: result.metrics,
    error: result.error,
  };
}
