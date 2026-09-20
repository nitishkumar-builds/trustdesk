// Vitest global setup (runs once per test file, before imports of the file under test).
//
// - Loads server/.env so tests see the same configuration as `npm run dev`.
// - Forces NODE_ENV=test and silent logging so request logs do not drown the test output.
// - Probes DATABASE_URL once; DB-backed suites call `describeWithDb` (tests/helpers/db.ts),
//   which skips them with a clear message when the database is unreachable.
import 'dotenv/config';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.AI_PROVIDER = process.env.AI_PROVIDER ?? 'mock';

import { probeDatabase } from './helpers/db.js';

await probeDatabase();
