import type { ToolDefinition } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { EXECUTORS } from './executors/index.js';
import type { ToolExecutor } from './types.js';

export interface RegisteredTool {
  definition: ToolDefinition;
  /** Mutable on purpose: tests spy on it to prove an executor ran exactly once. */
  executor: ToolExecutor;
}

export type ToolRegistry = Map<string, RegisteredTool>;

let cached: ToolRegistry | null = null;
let loading: Promise<ToolRegistry> | null = null;

/**
 * Loads ToolDefinition rows into a typed registry keyed by tool_name. Warmed at boot by
 * index.ts and lazily by the first request; `refreshToolRegistry()` reloads after a reseed.
 * A definition without an executor is a deployment error and fails loudly.
 */
export async function getToolRegistry(): Promise<ToolRegistry> {
  if (cached) return cached;
  if (!loading) {
    loading = loadRegistry().then((r) => {
      cached = r;
      loading = null;
      return r;
    }, (err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

export async function refreshToolRegistry(): Promise<ToolRegistry> {
  cached = null;
  return getToolRegistry();
}

async function loadRegistry(): Promise<ToolRegistry> {
  const definitions = await prisma.toolDefinition.findMany({ orderBy: { toolName: 'asc' } });
  const registry: ToolRegistry = new Map();
  for (const definition of definitions) {
    const executor = EXECUTORS[definition.toolName];
    if (!executor) throw new Error(`Tool ${definition.toolName} has a definition but no executor`);
    registry.set(definition.toolName, { definition, executor });
  }
  return registry;
}
