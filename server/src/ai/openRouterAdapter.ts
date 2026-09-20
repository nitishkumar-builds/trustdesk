import { env } from '../config/env.js';
import { aiProviderError } from '../errors/AppError.js';
import type { AiAdapter, AiRequest, AiResponse } from './types.js';

const RETRY_BACKOFF_MS = 1000;
const MAX_ATTEMPTS = 2; // one retry

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// Live provider. Never falls back to the mock: a failure surfaces as AI_PROVIDER_ERROR.
export class OpenRouterAdapter implements AiAdapter {
  readonly name = 'openrouter';

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    if (!env.OPENROUTER_API_KEY) {
      throw aiProviderError('OPENROUTER_API_KEY is not set', { provider: 'openrouter' });
    }

    const system = req.jsonSchema ? `${req.system}\n\n${jsonInstruction(req.jsonSchema)}` : req.system;
    const body = {
      model: env.OPENROUTER_MODEL,
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxTokens ?? 800,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.user },
      ],
      ...(req.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
    };

    const started = Date.now();
    let lastFailure = 'unknown';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.OPENROUTER_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': `http://localhost:${env.PORT}`,
            'X-Title': 'TrustDesk',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          lastFailure = `HTTP ${res.status}`;
          if (attempt < MAX_ATTEMPTS) {
            await this.sleep(RETRY_BACKOFF_MS);
            continue;
          }
          throw aiProviderError(`OpenRouter request failed with ${lastFailure}`, {
            status: res.status,
            attempts: attempt,
          });
        }
        if (!res.ok) {
          const detail = await safeText(res);
          throw aiProviderError(`OpenRouter request failed with HTTP ${res.status}`, {
            status: res.status,
            body: detail.slice(0, 500),
          });
        }

        const data = (await res.json()) as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw aiProviderError('OpenRouter response had no message content', { response: data });
        }
        const text = content.trim();
        const latencyMs = Date.now() - started;
        const tokenUsage =
          data.usage && typeof data.usage.prompt_tokens === 'number'
            ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens ?? 0 }
            : undefined;

        // Non-JSON output is NOT a provider error: it is handed back with json undefined so the
        // caller's validation treats it like a schema-invalid answer (corrective retry, then the
        // deterministic fallback, D-033/D-075). Prose around a JSON object is tolerated.
        let json: unknown;
        if (req.jsonSchema) json = parseJsonLenient(text);

        return {
          text,
          json,
          modelProvider: 'openrouter',
          modelName: data.model ?? env.OPENROUTER_MODEL,
          latencyMs,
          tokenUsage,
        };
      } catch (err) {
        if (isAbort(err)) {
          lastFailure = `timeout after ${env.OPENROUTER_TIMEOUT_MS}ms`;
          if (attempt < MAX_ATTEMPTS) {
            await this.sleep(RETRY_BACKOFF_MS);
            continue;
          }
          throw aiProviderError(`OpenRouter request timed out (${lastFailure})`, { attempts: attempt });
        }
        if (err instanceof Error && err.name === 'AppError') throw err;
        if (err instanceof TypeError) {
          // Network-level failure (DNS, refused connection). Treat like a 5xx: one retry.
          lastFailure = err.message;
          if (attempt < MAX_ATTEMPTS) {
            await this.sleep(RETRY_BACKOFF_MS);
            continue;
          }
          throw aiProviderError(`OpenRouter request failed: ${lastFailure}`, { attempts: attempt });
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    throw aiProviderError(`OpenRouter request failed: ${lastFailure}`);
  }
}

function jsonInstruction(schema: object): string {
  const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const keys = Object.keys(props);
  const described = keys
    .map((k) => {
      const p = props[k] as { type?: string; enum?: string[] } | undefined;
      const type = p?.enum ? `one of ${p.enum.map((e) => JSON.stringify(e)).join(' | ')}` : (p?.type ?? 'any');
      return `"${k}" (${type})`;
    })
    .join(', ');
  return `Respond with a single JSON object and nothing else. Required keys: ${described}. No markdown, no prose outside the JSON.`;
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** JSON.parse after fence stripping; falls back to the first {...} block in the text; undefined when nothing parses. */
export function parseJsonLenient(text: string): unknown {
  const stripped = stripCodeFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
