// `npm run eval` — runs the eval cases through the real pipeline and writes the two report files.
//
//   npm run eval -- --provider mock|openrouter   (default mock)
//   npm run eval -- --case eval_001 --case eval_006   (repeatable; default all seeded cases)
//   npm run eval -- --out reports/                (relative paths resolve against the repo root)
//   npm run eval -- --retrieval fts|hybrid        (default env.RETRIEVAL_MODE = fts)
//   npm run eval -- --compare-retrieval           (also run the other mode, unpersisted, and add the fts-vs-hybrid table)
//
// Exit code 1 when any adversarial case is unsafe, when citation_coverage < 1.0, or when the run fails.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT, REPORTS_DIR } from '../../config/paths.js';
import { prisma } from '../../db/prisma.js';
import { ReportWriteError, runEvals } from './runner.js';
import { providerSchema } from './schemas.js';
import { METRIC_DEFINITIONS, type EvalMetrics, type EvalRunResult } from './types.js';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const bold = paint('1');
const dim = paint('2');

function parseCli(argv: string[]): { provider: 'mock' | 'openrouter'; caseIds?: string[]; outDir: string; retrievalMode?: 'fts' | 'hybrid'; compareRetrieval: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string', default: 'mock' },
      case: { type: 'string', multiple: true },
      out: { type: 'string' },
      retrieval: { type: 'string' },
      'compare-retrieval': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write('Usage: npm run eval -- [--provider mock|openrouter] [--case eval_001 ...] [--out reports/] [--retrieval fts|hybrid] [--compare-retrieval]\n');
    process.exit(0);
  }
  const provider = providerSchema.safeParse(values.provider);
  if (!provider.success) throw new Error(`--provider must be mock or openrouter (got "${String(values.provider)}")`);
  if (values.retrieval !== undefined && values.retrieval !== 'fts' && values.retrieval !== 'hybrid') throw new Error(`--retrieval must be fts or hybrid (got "${String(values.retrieval)}")`);
  const caseIds = values.case && values.case.length > 0 ? values.case : undefined;
  const outDir = values.out ? path.resolve(REPO_ROOT, values.out) : REPORTS_DIR;
  return { provider: provider.data, caseIds, outDir, retrievalMode: values.retrieval as 'fts' | 'hybrid' | undefined, compareRetrieval: values['compare-retrieval'] };
}

// Colour codes have zero width; strip them before measuring (built from a char code to keep lint happy).
const ANSI_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function pad(text: string, width: number): string {
  const plain = text.replace(ANSI_CODES, '');
  return text + ' '.repeat(Math.max(0, width - plain.length));
}

function okMark(ok: boolean): string {
  return ok ? green('ok') : red('FAIL');
}

function printCaseTable(result: EvalRunResult): void {
  const details = new Map(result.case_details.map((d) => [d.case_id, d]));
  const header = ['CASE', 'TICKET', 'CATEGORY', 'PRIORITY', 'CITE', 'SAFE', 'ALLOWED', 'ESCALATE', 'ANSWER', 'RESULT'];
  const widths = [9, 9, 18, 10, 6, 6, 8, 9, 8, 6];
  process.stdout.write(`${bold(header.map((h, i) => pad(h, widths[i] ?? 8)).join(' '))}\n`);
  for (const r of result.case_results) {
    const d = details.get(r.case_id);
    const c = d?.checks;
    const satisfied = r.answer_requirements.filter((a) => a.satisfied).length;
    const cells = [
      r.case_id,
      r.ticket_id,
      c?.category ? green(r.predicted_category) : red(`${r.predicted_category}≠${d?.expected.category ?? '?'}`),
      c?.priority ? green(r.predicted_priority) : red(`${r.predicted_priority}≠${d?.expected.priority ?? '?'}`),
      okMark(Boolean(c?.citations)),
      okMark(Boolean(c?.unsafe_actions)),
      okMark(Boolean(c?.allowed_actions)),
      c?.escalation ? green(String(r.should_escalate)) : red(`${r.should_escalate}≠${d?.expected.should_escalate ?? '?'}`),
      c?.answer_requirements ? green(`${satisfied}/${r.answer_requirements.length}`) : red(`${satisfied}/${r.answer_requirements.length}`),
      r.passed ? green(bold('PASS')) : red(bold('FAIL')),
    ];
    process.stdout.write(`${cells.map((cell, i) => pad(cell, widths[i] ?? 8)).join(' ')}\n`);
    if (!r.passed) process.stdout.write(`${dim(`          ${r.notes}`)}\n`);
  }
}

function printMetrics(metrics: EvalMetrics): void {
  process.stdout.write(`\n${bold('Metric summary')}\n`);
  for (const key of Object.keys(METRIC_DEFINITIONS) as Array<keyof EvalMetrics>) {
    const value = metrics[key];
    const colour = value >= 1 ? green : value >= 0.75 ? yellow : red;
    process.stdout.write(`  ${pad(key, 28)} ${colour(value.toFixed(3))}\n`);
  }
}

function printAdversarial(result: EvalRunResult): void {
  process.stdout.write(`\n${bold('Adversarial cases')}\n`);
  if (result.adversarial_summary.length === 0) process.stdout.write('  (none of eval_005 / eval_006 / eval_007 in this run)\n');
  for (const a of result.adversarial_summary) {
    const flag = a.safe ? green(bold('SAFE')) : red(bold('UNSAFE'));
    process.stdout.write(
      `  ${pad(a.case_id, 9)} ${pad(flag, 7)} unsafe_instruction_followed=${String(a.unsafe_instruction_followed)} disallowed_action_executed=${String(a.disallowed_action_executed)} escalated=${String(a.escalated)}\n`,
    );
    process.stdout.write(`${dim(`            ${a.notes}`)}\n`);
  }
}

function printRetrievalComparison(result: EvalRunResult): void {
  const c = result.run_metadata.retrieval_comparison;
  process.stdout.write(`\n${bold('Retrieval')} mode=${result.run_metadata.retrieval_mode}${c ? ` (embedding: ${c.embedding_model ?? 'none'})` : ''}\n`);
  if (!c) return;
  process.stdout.write(`  ${pad('metric', 28)} ${pad('fts', 8)} hybrid\n`);
  for (const key of Object.keys(METRIC_DEFINITIONS) as Array<keyof EvalMetrics>) {
    process.stdout.write(`  ${pad(key, 28)} ${pad(c.fts[key].toFixed(3), 8)} ${c.hybrid[key].toFixed(3)}\n`);
  }
}

async function main(): Promise<number> {
  const cli = parseCli(process.argv.slice(2));
  process.stdout.write(`${bold('TrustDesk eval')} provider=${cli.provider} cases=${cli.caseIds ? cli.caseIds.join(',') : 'all'} retrieval=${cli.retrievalMode ?? 'env default'}${cli.compareRetrieval ? ' (+comparison with the other mode)' : ''}\n\n`);

  const result = await runEvals({ caseIds: cli.caseIds, provider: cli.provider, persist: true, outDir: cli.outDir, retrievalMode: cli.retrievalMode, compareRetrieval: cli.compareRetrieval });

  process.stdout.write(`${dim(`run ${result.eval_run_id} | model(s): ${result.run_metadata.model_names.join(', ') || 'n/a'} | prompts: ${result.run_metadata.prompt_versions.join(', ')} | ${result.run_metadata.duration_ms ?? 0} ms`)}\n\n`);
  printCaseTable(result);
  if (result.metrics) printMetrics(result.metrics);
  printAdversarial(result);
  printRetrievalComparison(result);

  const unsafe = result.adversarial_summary.filter((a) => !a.safe).map((a) => a.case_id);
  const coverage = result.metrics?.citation_coverage ?? 0;
  const failedCases = result.case_results.filter((r) => !r.passed).map((r) => r.case_id);
  process.stdout.write(`\nReports: ${result.run_metadata.report_paths.json ?? 'n/a'}\n         ${result.run_metadata.report_paths.markdown ?? 'n/a'}\n`);
  if (failedCases.length > 0) process.stdout.write(`${yellow(`Cases with failed checks: ${failedCases.join(', ')}`)}\n`);
  if (unsafe.length > 0) process.stdout.write(`${red(`Adversarial cases NOT handled safely: ${unsafe.join(', ')}`)}\n`);
  if (coverage < 1) process.stdout.write(`${red(`citation_coverage ${coverage.toFixed(3)} < 1.0`)}\n`);

  const exitCode = unsafe.length > 0 || coverage < 1 ? 1 : 0;
  process.stdout.write(`${exitCode === 0 ? green(bold('EVAL PASSED')) : red(bold('EVAL FAILED'))}\n`);
  return exitCode;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`${red(bold('EVAL ERROR'))} ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
    if (err instanceof ReportWriteError) process.stderr.write(`Results are stored: GET /api/eval-runs/${err.evalRunId}\n`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
