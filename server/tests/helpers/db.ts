import { describe } from 'vitest';

interface DbProbe {
  available: boolean;
  reason: string;
}

const g = globalThis as unknown as { __trustdeskDbProbe?: DbProbe };

// Called once from tests/setup.ts. Uses a throwaway PrismaClient so a dead database cannot
// poison the app singleton, and a hard timeout so the probe never hangs the run.
export async function probeDatabase(): Promise<DbProbe> {
  if (g.__trustdeskDbProbe) return g.__trustdeskDbProbe;

  const url = process.env.DATABASE_URL;
  if (!url) {
    g.__trustdeskDbProbe = { available: false, reason: 'DATABASE_URL is not set' };
    return g.__trustdeskDbProbe;
  }

  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try {
    await Promise.race([
      client.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('connection probe timed out after 5000ms')), 5000),
      ),
    ]);
    g.__trustdeskDbProbe = { available: true, reason: '' };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'unknown error';
    g.__trustdeskDbProbe = {
      available: false,
      reason: `DATABASE_URL is unreachable (${message}). Start it with \`docker compose up -d\` and seed with \`npm run db:seed\`.`,
    };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
  return g.__trustdeskDbProbe;
}

export function dbProbe(): DbProbe {
  return g.__trustdeskDbProbe ?? { available: false, reason: 'database probe has not run' };
}

// `describeWithDb('name', () => {...})` runs the suite only when Postgres answered the probe;
// otherwise it registers a skipped suite whose title carries the reason.
export function describeWithDb(name: string, fn: () => void): void {
  const probe = dbProbe();
  if (probe.available) {
    describe(name, fn);
  } else {
    describe.skip(`${name} — SKIPPED: ${probe.reason}`, fn);
  }
}
