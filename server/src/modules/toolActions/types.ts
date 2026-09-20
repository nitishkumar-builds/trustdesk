import type { Customer, Order, Ticket, ToolActionRequest } from '@prisma/client';

export interface ExecutorContext {
  action: ToolActionRequest;
  ticket: Ticket & { customer: Customer; order: Order | null };
  requestedBy: string;
}

export interface ExecutorResult {
  ok: boolean;
  result: Record<string, unknown>;
}

// Every executor is SIMULATED: it derives a result object (and a fake downstream id) and never
// calls an external system. The result always carries { simulated: true }.
export type ToolExecutor = (payload: Record<string, unknown>, ctx: ExecutorContext) => Promise<ExecutorResult>;
