import type { AiAdapter, AiRequest, AiResponse } from '../../ai/index.js';
import type { EvalCaseInput } from './types.js';

export interface PromptObservation {
  requests: AiRequest[];
  responses: AiResponse[];
}

/**
 * Wraps the real adapter so the runner sees every prompt payload the pipeline sends. The name is
 * passed through, so traces still record the underlying provider.
 */
export function observingAdapter(inner: AiAdapter, observation: PromptObservation): AiAdapter {
  return {
    name: inner.name,
    async complete(req: AiRequest): Promise<AiResponse> {
      observation.requests.push(req);
      const res = await inner.complete(req);
      observation.responses.push(res);
      return res;
    },
  };
}

export class ExpectationLeakError extends Error {
  constructor(
    public readonly caseId: string,
    public readonly leaks: string[],
  ) {
    super(`Rule R2 violation: a prompt payload for ${caseId} contains evaluation-only data: ${leaks.join('; ')}`);
    this.name = 'ExpectationLeakError';
  }
}

/**
 * Strings that exist only on TicketExpectation / EvalCase. Bare label VALUES ("refund", "high")
 * are deliberately not checked: the triage system prompt lists every category and priority, and
 * the draft prompt carries the system's own triage output, so a value match cannot tell a leak
 * from normal operation (CLAUDE.md D-052). Labelled keys and eval-only prose can.
 */
const EXPECTATION_MARKERS = [
  'expected_category',
  'expected_priority',
  'expected_sentiment',
  'expected_escalation',
  'expected_actions',
  'must_cite_doc_ids',
  'allowed_actions',
  'disallowed_actions',
  'answer_requirements',
  'ticket_expectation',
  'eval_case',
  '"expected"',
  'expected:',
  'expected_',
] as const;

const MIN_NEEDLE_LENGTH = 4;

export function findExpectationLeaks(requests: AiRequest[], evalCase: EvalCaseInput): string[] {
  const needles: Array<{ label: string; text: string }> = [
    ...EXPECTATION_MARKERS.map((m) => ({ label: `marker "${m}"`, text: m })),
    { label: `case id "${evalCase.caseId}"`, text: evalCase.caseId },
    ...evalCase.expected.answer_requirements.map((r) => ({ label: `answer requirement "${r}"`, text: r })),
    { label: 'the serialised expected object', text: JSON.stringify(evalCase.expected) },
  ];

  const leaks: string[] = [];
  requests.forEach((req, index) => {
    const haystack = `${req.system}\n${req.user}`.toLowerCase();
    const found = new Set<string>();
    for (const needle of needles) {
      const text = needle.text.trim().toLowerCase();
      if (text.length < MIN_NEEDLE_LENGTH) continue;
      if (haystack.includes(text)) found.add(needle.label);
    }
    for (const label of found) leaks.push(`prompt #${index + 1} (${req.promptVersion}) contains ${label}`);
  });
  return leaks;
}

/** Throws ExpectationLeakError when any observed prompt carries expected data (rule R2). */
export function assertNoExpectationLeak(requests: AiRequest[], evalCase: EvalCaseInput): void {
  const leaks = findExpectationLeaks(requests, evalCase);
  if (leaks.length > 0) throw new ExpectationLeakError(evalCase.caseId, leaks);
}
