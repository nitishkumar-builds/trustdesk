import pino from 'pino';
import { env } from '../../config/env.js';
import { newId } from '../../db/ids.js';
import { prisma } from '../../db/prisma.js';
import { notFoundError } from '../../errors/AppError.js';
import type { Principal } from '../../middleware/auth.js';
import { mapEvalRun, mapEvalRunSummary, type EvalRunDto, type EvalRunSummaryDto } from './mappers.js';
import { createRunRow, loadEvalCases, markRunFailed, runEvals } from './runner.js';
import type { StartEvalRunBody } from './schemas.js';

const log = pino({ level: env.LOG_LEVEL, name: 'eval-runs' });

// Background runs still in flight (tests and a graceful shutdown can await them).
const inFlight = new Set<Promise<void>>();

/**
 * POST /api/eval-runs: validates the case ids, inserts the EvalRun row with completedAt null,
 * returns immediately and completes the run in the background (docs/API_CONTRACT.md section 11).
 */
export async function startEvalRun(body: StartEvalRunBody, principal: Principal): Promise<{ eval_run_id: string; status: 'running' }> {
  const provider = body.provider ?? 'mock';
  const cases = await loadEvalCases(body.case_ids);
  const caseIds = cases.map((c) => c.caseId);
  const evalRunId = newId('evalRun');
  await createRunRow(evalRunId, new Date(), provider, caseIds);

  const task = runEvals({ caseIds, provider, persist: true, evalRunId, principal })
    .then(() => log.info({ evalRunId }, 'eval run completed'))
    .catch(async (err: unknown) => {
      log.error({ evalRunId, err }, 'eval run failed');
      await markRunFailed(evalRunId, err); // idempotent; covers a failure the runner could not record itself
    })
    .finally(() => inFlight.delete(task));
  inFlight.add(task);

  return { eval_run_id: evalRunId, status: 'running' };
}

export async function waitForBackgroundEvalRuns(): Promise<void> {
  await Promise.allSettled([...inFlight]);
}

export async function getEvalRun(evalRunId: string): Promise<EvalRunDto> {
  const row = await prisma.evalRun.findUnique({ where: { evalRunId } });
  if (!row) throw notFoundError(`Eval run ${evalRunId} not found`);
  return mapEvalRun(row);
}

export async function listEvalRuns(limit: number): Promise<{ items: EvalRunSummaryDto[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.evalRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit }),
    prisma.evalRun.count(),
  ]);
  return { items: rows.map(mapEvalRunSummary), total };
}
