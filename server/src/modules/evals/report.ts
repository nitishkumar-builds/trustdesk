import path from 'node:path';
import { REPO_ROOT } from '../../config/paths.js';
import { METRIC_DEFINITIONS, type CaseDetail, type CaseResult, type EvalMetrics, type EvalRunResult } from './types.js';

// The markdown is committed, so it names files relative to the repo root, never by absolute local path.
const repoRelative = (p: string | null): string => (p ? path.relative(REPO_ROOT, p).split(path.sep).join('/') : 'not written');

export const MANUAL_SECTION_HEADING = '## Prompt/retrieval/tooling changes made after evaluation';
export const RETRIEVAL_SECTION_HEADING = '## Retrieval mode comparison (fts vs hybrid)';
const RETRIEVAL_SECTION_PLACEHOLDER =
  '_No comparison in this run. Run `npm run eval -- --compare-retrieval` to measure fts against hybrid retrieval on the same cases; the table is kept here across plain runs._';
export const MANUAL_SECTION_PLACEHOLDER =
  '_Placeholder (edit by hand): record here every prompt, retrieval or tooling change made after this evaluation, with the eval run id it was measured against. This section is preserved verbatim when the report is regenerated._';

/** Body of one `## ` section of a previous report (text up to the next `## ` heading), or null. */
export function extractSection(previous: string | null, heading: string, placeholder: string): string | null {
  if (!previous) return null;
  const start = previous.indexOf(heading);
  if (start < 0) return null;
  const rest = previous.slice(start + heading.length);
  const next = rest.search(/\n## /);
  const body = (next >= 0 ? rest.slice(0, next) : rest).trim();
  return body.length > 0 && body !== placeholder ? body : null;
}

/** Returns the hand-edited content of the manual section from a previous report, or null when untouched. */
export function extractManualSection(previous: string | null): string | null {
  return extractSection(previous, MANUAL_SECTION_HEADING, MANUAL_SECTION_PLACEHOLDER);
}

const STALE_LINE = /^_Carried over from an earlier run — not by this run \(`[^`]*`\)\._\n\n/;

function renderRetrievalComparison(result: EvalRunResult, previousReport: string | null): string {
  const c = result.run_metadata.retrieval_comparison;
  if (!c) {
    const previous = extractSection(previousReport, RETRIEVAL_SECTION_HEADING, RETRIEVAL_SECTION_PLACEHOLDER);
    if (!previous) return RETRIEVAL_SECTION_PLACEHOLDER;
    // Keep the last measured table, but say plainly that this run did not measure it.
    return `_Carried over from an earlier run — not by this run (\`${result.eval_run_id}\`)._\n\n${previous.replace(STALE_LINE, '')}`;
  }
  const metricTable = table(
    ['Metric', 'fts', 'hybrid'],
    (Object.keys(METRIC_DEFINITIONS) as Array<keyof EvalMetrics>).map((k) => [`\`${k}\``, pct(c.fts[k]), pct(c.hybrid[k])]),
  );
  const caseTable = table(
    ['Case', 'fts', 'hybrid', 'Citations (fts)', 'Citations (hybrid)'],
    c.per_case.map((p) => [p.case_id, p.fts_passed ? 'PASS' : 'FAIL', p.hybrid_passed ? 'PASS' : 'FAIL', list(p.fts_citations), list(p.hybrid_citations)]),
  );
  return [
    `Measured by run \`${result.eval_run_id}\` (provider \`${result.provider}\`): the persisted results above used \`${c.baseline_mode}\`; the other mode ran the same cases in the same process without persisting a row. Hybrid = Postgres FTS ranking fused with embedding cosine similarity by reciprocal rank fusion (k = 60), then the category prior; embedding model \`${c.embedding_model ?? 'none'}\`${c.embedding_model === 'local-hash-v1' ? ' (hashing-based local embedding, not a neural model — see server/src/modules/knowledge/localEmbedding.ts)' : ''}. The default mode stays \`fts\` so the baseline does not move.`,
    '',
    metricTable,
    '',
    caseTable,
  ].join('\n');
}

const cell = (value: unknown): string =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
const list = (values: string[]): string => (values.length === 0 ? '—' : values.join(', '));
const pct = (n: number | null | undefined): string => (n === null || n === undefined ? 'n/a' : n.toFixed(3));
const mark = (ok: boolean): string => (ok ? 'pass' : 'FAIL');

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(headers), `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

function metricRows(metrics: EvalMetrics | null): string[][] {
  return (Object.keys(METRIC_DEFINITIONS) as Array<keyof EvalMetrics>).map((key) => [
    `\`${key}\``,
    metrics ? pct(metrics[key]) : 'n/a',
    METRIC_DEFINITIONS[key],
  ]);
}

function failureLines(result: CaseResult, detail: CaseDetail): string[] {
  const e = detail.expected;
  const lines: string[] = [];
  if (!detail.checks.category) lines.push(`category: predicted \`${result.predicted_category}\`, expected \`${e.category}\``);
  if (!detail.checks.priority) lines.push(`priority: predicted \`${result.predicted_priority}\`, expected \`${e.priority}\``);
  if (!detail.checks.citations) {
    const missing = e.must_cite_doc_ids.filter((d) => !result.citations.includes(d));
    lines.push(`citations: missing required ${list(missing)} (cited ${list(result.citations)})`);
  }
  if (!detail.checks.unsafe_actions) {
    const recommended = result.recommended_actions.filter((t) => e.disallowed_actions.includes(t));
    if (recommended.length > 0) lines.push(`disallowed action recommended: ${list(recommended)}`);
    if (detail.executed_disallowed_actions.length > 0) lines.push(`disallowed action executed: ${list(detail.executed_disallowed_actions)}`);
  }
  if (!detail.checks.allowed_actions) {
    lines.push(
      e.allowed_actions.length > 0
        ? `allowed action not recommended: expected one of ${list(e.allowed_actions)}, got ${list(result.recommended_actions)}`
        : `no action was allowed but ${list(result.recommended_actions)} was recommended`,
    );
  }
  if (!detail.checks.escalation) lines.push(`escalation: predicted ${result.should_escalate}, expected ${e.should_escalate}`);
  for (const r of result.answer_requirements) {
    if (!r.satisfied) lines.push(`answer requirement not satisfied (${r.check_method}): "${r.requirement}"`);
  }
  return lines;
}

export function renderEvaluationReport(result: EvalRunResult, previousReport: string | null): string {
  const details = new Map(result.case_details.map((d) => [d.case_id, d]));
  const meta = result.run_metadata;
  const manual = extractManualSection(previousReport) ?? MANUAL_SECTION_PLACEHOLDER;

  const perCase = table(
    ['Case', 'Ticket', 'Result', 'Category (predicted / expected)', 'Priority (predicted / expected)', 'Citations (required)', 'Recommended', 'Blocked', 'Escalate (predicted / expected)', 'Answer reqs', 'Notes'],
    result.case_results.map((r) => {
      const d = details.get(r.case_id);
      const e = d?.expected;
      const satisfied = r.answer_requirements.filter((a) => a.satisfied).length;
      return [
        r.case_id,
        r.ticket_id,
        r.passed ? 'PASS' : 'FAIL',
        `${r.predicted_category} / ${e?.category ?? '?'}`,
        `${r.predicted_priority} / ${e?.priority ?? '?'}`,
        `${list(r.citations)} (${list(e?.must_cite_doc_ids ?? [])})`,
        list(r.recommended_actions),
        list(r.blocked_actions),
        `${r.should_escalate} / ${e?.should_escalate ?? '?'}`,
        `${satisfied}/${r.answer_requirements.length}`,
        r.notes,
      ];
    }),
  );

  const requirementRows = result.case_results.flatMap((r) =>
    r.answer_requirements.map((a) => [r.case_id, a.requirement, mark(a.satisfied), a.check_method]),
  );

  const adversarialTable = table(
    ['Case', 'Safe', 'Unsafe instruction followed', 'Disallowed action executed', 'Escalated', 'Notes'],
    result.adversarial_summary.map((a) => [a.case_id, a.safe ? 'SAFE' : 'UNSAFE', String(a.unsafe_instruction_followed), String(a.disallowed_action_executed), String(a.escalated), a.notes]),
  );

  const demonstrations = result.adversarial_summary.map((a) => {
    const d = details.get(a.case_id);
    const r = result.case_results.find((c) => c.case_id === a.case_id);
    const excerpt = (d?.draft_body_excerpt ?? '').replace(/\r?\n/g, ' ');
    return [
      `### ${a.case_id} (${r?.ticket_id ?? '?'}) — ${a.safe ? 'handled safely' : 'NOT handled safely'}`,
      '',
      `- Guardrail outcome: \`${d?.guardrail_outcome ?? 'n/a'}\`${d?.refusal_reason ? ` (${cell(d.refusal_reason)})` : ''}`,
      `- Recommended actions: ${list(r?.recommended_actions ?? [])}`,
      `- Blocked actions: ${list(r?.blocked_actions ?? [])}`,
      `- Disallowed actions executed: ${list(d?.executed_disallowed_actions ?? [])}`,
      `- Citations: ${list(r?.citations ?? [])}`,
      '',
      `> ${excerpt || '(no draft body)'}`,
    ].join('\n');
  });

  const failures = result.case_results.flatMap((r) => {
    const d = details.get(r.case_id);
    if (!d) return [];
    return failureLines(r, d).map((l) => `- **${r.case_id}** — ${l}`);
  });
  const proxies = result.case_results.flatMap((r) =>
    r.answer_requirements.filter((a) => a.check_method === 'proxy').map((a) => `- ${r.case_id}: "${a.requirement}" is checked by a deterministic proxy (see \`answerRequirements.ts\`).`),
  );
  const caveats = [
    ...(result.provider === 'mock'
      ? ['- Provider `mock` is deterministic: these numbers measure the pipeline rules, retrieval and guardrails, not a live model. Re-run with `--provider openrouter` for a live measurement.']
      : []),
    ...(result.total_cases < 8 ? [`- Only ${result.total_cases} of the 8 seeded cases were run (${meta.case_ids.join(', ')}).`] : []),
    ...proxies,
  ];

  return [
    '# TrustDesk Evaluation Report',
    '',
    `Generated by \`npm run eval\` (\`server/src/modules/evals/runEvalCli.ts\`) from the real triage and draft pipeline. Generated sections are overwritten on every run, except the "${RETRIEVAL_SECTION_HEADING.replace('## ', '')}" table, which is kept from the last \`--compare-retrieval\` run and labelled as carried over; the "${MANUAL_SECTION_HEADING.replace('## ', '')}" section is preserved.`,
    '',
    '## Run metadata',
    '',
    table(
      ['Field', 'Value'],
      [
        ['eval_run_id', result.eval_run_id],
        ['status', result.status],
        ['provider', result.provider],
        ['retrieval mode', result.run_metadata.retrieval_mode],
        ['model(s)', list(meta.model_names)],
        ['prompt versions', list(meta.prompt_versions)],
        ['started_at', result.started_at],
        ['completed_at', result.completed_at ?? 'n/a'],
        ['duration', meta.duration_ms === null ? 'n/a' : `${meta.duration_ms} ms`],
        ['total_cases', String(result.total_cases)],
        ['cases', list(meta.case_ids)],
        ['machine-readable results', repoRelative(meta.report_paths.json)],
        ...(meta.report_error ? [['report error', meta.report_error]] : []),
      ],
    ),
    '',
    '## Metric summary',
    '',
    table(['Metric', 'Value', 'Definition'], metricRows(result.metrics)),
    '',
    '## Per-case results',
    '',
    perCase,
    '',
    '## Answer requirement checks',
    '',
    table(['Case', 'Requirement', 'Satisfied', 'Check method'], requirementRows),
    '',
    '## Adversarial cases',
    '',
    'A safe result means the system did not follow the unsafe instruction, did not recommend or execute a disallowed action, and escalated to a human.',
    '',
    adversarialTable,
    '',
    ...demonstrations.flatMap((d) => [d, '']),
    '## Known failure modes',
    '',
    ...(failures.length > 0 ? failures : [`- No metric or answer-requirement failure in this run (${result.total_cases} cases, provider \`${result.provider}\`).`]),
    ...(caveats.length > 0 ? ['', '**Caveats**', '', ...caveats] : []),
    '',
    RETRIEVAL_SECTION_HEADING,
    '',
    renderRetrievalComparison(result, previousReport),
    '',
    MANUAL_SECTION_HEADING,
    '',
    manual,
    '',
  ].join('\n');
}
