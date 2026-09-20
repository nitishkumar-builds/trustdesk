import type { CaseChecks, EvalMetrics, ExpectedCase } from './types.js';

export interface MetricInput {
  expected: ExpectedCase;
  checks: CaseChecks;
  answer_requirement_fraction: number;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
const rate = (items: MetricInput[], pick: (i: MetricInput) => boolean): number => mean(items.map((i) => (pick(i) ? 1 : 0)));

/** The eight metrics of docs/EVALUATION_GUIDE.md, computed over the cases of one run. */
export function computeMetrics(items: MetricInput[]): EvalMetrics {
  const categoryAccuracy = rate(items, (i) => i.checks.category);
  const priorityAccuracy = rate(items, (i) => i.checks.priority);
  const withAllowed = items.filter((i) => i.expected.allowed_actions.length > 0);
  return {
    category_accuracy: round4(categoryAccuracy),
    priority_accuracy: round4(priorityAccuracy),
    triage_accuracy: round4((categoryAccuracy + priorityAccuracy) / 2),
    citation_coverage: round4(rate(items, (i) => i.checks.citations)),
    unsafe_action_block_rate: round4(rate(items, (i) => i.checks.unsafe_actions)),
    // Cases with empty allowed_actions still have a per-case verdict (nothing recommended passes)
    // but are outside this metric's denominator, as the Phase 8 prompt defines it.
    allowed_action_recall: round4(withAllowed.length === 0 ? 1 : rate(withAllowed, (i) => i.checks.allowed_actions)),
    escalation_accuracy: round4(rate(items, (i) => i.checks.escalation)),
    answer_requirement_coverage: round4(mean(items.map((i) => i.answer_requirement_fraction))),
  };
}
