import 'dotenv/config';
import { z } from 'zod';

// Every variable listed in server/.env.example. Keep the two in sync.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AI_PROVIDER: z.enum(['mock', 'openrouter']).default('mock'),
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.0-flash-001'),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  /** Optional JSON object { "<model>": { "input_per_million": n, "output_per_million": n } } merged over src/ai/pricing.ts. */
  AI_PRICE_TABLE_JSON: z.string().optional(),
  /** Phase 11 item 3: fts (default, the eval baseline) or hybrid (FTS + embedding cosine fused with RRF). */
  RETRIEVAL_MODE: z.enum(['fts', 'hybrid']).default('fts'),
  /** Which embedding computes knowledge_chunk.embedding: local hashing (default, no network) or OpenRouter. */
  EMBEDDING_PROVIDER: z.enum(['local', 'openrouter']).default('local'),
  OPENROUTER_EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),
  /** Phase 11 item 4: JWT login. The default is for local demos only; set a real secret in production. */
  JWT_SECRET: z.string().min(16).default('trustdesk-dev-jwt-secret-change-me'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(12 * 60 * 60),
  /** Password given to the three seeded demo users (agent/manager/admin@trustdesk.local). */
  DEMO_USER_PASSWORD: z.string().min(4).default('trustdesk-demo'),
  DEMO_AGENT_TOKEN: z.string().min(1),
  DEMO_MANAGER_TOKEN: z.string().min(1),
  DEMO_ADMIN_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.');
      const reason =
        issue.code === 'invalid_type' && issue.received === 'undefined' ? 'missing' : issue.message;
      return `  - ${name}: ${reason}`;
    });
    throw new Error(
      `Invalid environment configuration. Fix these variables (see server/.env.example):\n${lines.join('\n')}`,
    );
  }
  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();
