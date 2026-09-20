export interface AiRequest {
  promptVersion: string;
  system: string;
  user: string;
  /** When present the adapter asks for JSON and parses it into `AiResponse.json`. */
  jsonSchema?: object;
  maxTokens?: number;
  temperature?: number;
}

export interface AiResponse {
  text: string;
  json?: unknown;
  modelProvider: string;
  modelName: string;
  latencyMs: number;
  tokenUsage?: { prompt: number; completion: number };
  costEstimate?: number;
}

export interface AiAdapter {
  name: string;
  complete(req: AiRequest): Promise<AiResponse>;
}

export type AiProviderName = 'mock' | 'openrouter';
