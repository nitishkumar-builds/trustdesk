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
