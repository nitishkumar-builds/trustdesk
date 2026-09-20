/**
 * Idempotent seeder: loads the capstone pack from data/ into PostgreSQL.
 *
 *   npm run db:seed            upsert everything (safe to re-run; counts never change)
 *   npm run db:seed -- --reset truncate every table first, then seed
 *
 * Rule R2: expected_* ticket labels are split off into TicketExpectation here and nowhere else
 * outside modules/evals/ may read them.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { DATA_DIR, KNOWLEDGE_BASE_DIR, REPO_ROOT } from '../config/paths.js';
import { loadKnowledgeBase } from '../modules/knowledge/loader.js';
import { persistParsedDocument } from '../modules/knowledge/service.js';
import { hashPassword } from '../modules/auth/passwords.js';
import { env } from '../config/env.js';

interface RawCustomer {
  customer_id: string;
  name: string;
  email: string;
  tier: string;
  country: string;
  created_at: string;
  verified: boolean;
  tags: string[];
}

interface RawOrder {
  order_id: string;
  customer_id: string;
  status: string;
  placed_at: string;
  delivered_at: string | null;
  eligible_return_until: string | null;
  total: number;
  currency: string;
  payment_status: string;
  tracking_number: string;
  items: unknown[];
}

interface RawTicket {
  ticket_id: string;
  customer_id: string;
  order_id: string | null;
  channel: string;
  subject: string;
  body: string;
  created_at: string;
  status: string;
  expected_category: string;
  expected_priority: string;
  expected_sentiment: string;
  expected_escalation: boolean;
  expected_actions: string[];
}

interface RawToolAction {
  tool_name: string;
  description: string;
  risk_level: string;
  requires_human_approval: boolean;
  allowed_categories: string[];
  required_fields: string[];
  max_amount_inr?: number;
}

interface RawEvalCase {
  case_id: string;
  ticket_id: string;
  input: string;
  expected: Record<string, unknown>;
}

// Date-only pack values become DateTime at 00:00 UTC (CLAUDE.md schema decision).
function dateOnlyToUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DATA_DIR, file), 'utf8')) as T;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await readFile(path.join(DATA_DIR, file), 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);
}

// Truncation order does not matter with CASCADE; RESTART IDENTITY is harmless (no serials).
const ALL_TABLES = [
  'user',
  'feedback',
  'eval_run',
  'eval_case',
  'agent_run',
  'approval',
  'tool_action_request',
  'tool_definition',
  'draft_reply',
  'triage_result',
  'knowledge_chunk',
  'knowledge_document',
  'ticket_expectation',
  'ticket',
  'order',
  'customer',
];

async function resetDatabase(): Promise<void> {
  const list = ALL_TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// Phase 11 item 4: the three demo identities as login users (same ids the demo tokens resolve to).
export const DEMO_USERS = [
  { userId: 'usr_agent', email: 'agent@trustdesk.local', name: 'Demo Agent', role: 'support_agent' },
  { userId: 'usr_manager', email: 'manager@trustdesk.local', name: 'Demo Manager', role: 'support_manager' },
  { userId: 'usr_admin', email: 'admin@trustdesk.local', name: 'Demo Admin', role: 'admin' },
] as const;

async function seedUsers(): Promise<void> {
  for (const u of DEMO_USERS) {
    const data = { email: u.email, name: u.name, role: u.role, passwordHash: hashPassword(env.DEMO_USER_PASSWORD) };
    await prisma.user.upsert({ where: { userId: u.userId }, create: { userId: u.userId, ...data }, update: data });
  }
}

async function seedCustomers(): Promise<void> {
  const customers = await readJson<RawCustomer[]>('customers.json');
  for (const c of customers) {
    const data = {
      name: c.name,
      email: c.email,
      tier: c.tier,
      country: c.country,
      createdAt: dateOnlyToUtc(c.created_at)!,
      verified: c.verified,
      tags: c.tags,
    };
    await prisma.customer.upsert({
      where: { customerId: c.customer_id },
      create: { customerId: c.customer_id, ...data },
      update: data,
    });
  }
}

async function seedOrders(): Promise<void> {
  const orders = await readJson<RawOrder[]>('orders.json');
  for (const o of orders) {
    const data = {
      customerId: o.customer_id,
      status: o.status,
      placedAt: dateOnlyToUtc(o.placed_at)!,
      deliveredAt: dateOnlyToUtc(o.delivered_at),
      eligibleReturnUntil: dateOnlyToUtc(o.eligible_return_until),
      total: o.total,
      currency: o.currency,
      paymentStatus: o.payment_status,
      trackingNumber: o.tracking_number,
      items: o.items as Prisma.InputJsonValue,
    };
    await prisma.order.upsert({
      where: { orderId: o.order_id },
      create: { orderId: o.order_id, ...data },
      update: data,
    });
  }
}

async function seedTickets(): Promise<void> {
  const tickets = await readJson<RawTicket[]>('tickets.json');
  for (const t of tickets) {
    const ticketData = {
      customerId: t.customer_id,
      orderId: t.order_id ?? null,
      channel: t.channel,
      subject: t.subject,
      body: t.body, // stored verbatim, never trimmed or rewritten
      createdAt: new Date(t.created_at), // full timestamptz, offset preserved as an instant
      status: t.status,
    };
    await prisma.ticket.upsert({
      where: { ticketId: t.ticket_id },
      create: { ticketId: t.ticket_id, ...ticketData },
      update: ticketData,
    });

    // Rule R2: evaluation-only labels go to their own table.
    const expectationData = {
      expectedCategory: t.expected_category,
      expectedPriority: t.expected_priority,
      expectedSentiment: t.expected_sentiment,
      expectedEscalation: t.expected_escalation,
      expectedActions: t.expected_actions,
    };
    await prisma.ticketExpectation.upsert({
      where: { ticketId: t.ticket_id },
      create: { ticketId: t.ticket_id, ...expectationData },
      update: expectationData,
    });
  }
}

async function seedToolDefinitions(): Promise<void> {
  const tools = await readJson<RawToolAction[]>('tool_actions.json');
  for (const tool of tools) {
    const data = {
      description: tool.description,
      riskLevel: tool.risk_level,
      requiresHumanApproval: tool.requires_human_approval,
      allowedCategories: tool.allowed_categories,
      requiredFields: tool.required_fields,
      maxAmountInr: tool.max_amount_inr ?? null,
    };
    await prisma.toolDefinition.upsert({
      where: { toolName: tool.tool_name },
      create: { toolName: tool.tool_name, ...data },
      update: data,
    });
  }
}

async function seedEvalCases(): Promise<void> {
  const cases = await readJsonl<RawEvalCase>('eval_cases.jsonl');
  for (const c of cases) {
    const data = {
      ticketId: c.ticket_id,
      input: c.input,
      expected: c.expected as Prisma.InputJsonObject,
    };
    await prisma.evalCase.upsert({
      where: { caseId: c.case_id },
      create: { caseId: c.case_id, ...data },
      update: data,
    });
  }
}

async function seedKnowledgeBase(): Promise<void> {
  const docs = await loadKnowledgeBase(KNOWLEDGE_BASE_DIR, REPO_ROOT);
  for (const doc of docs) await persistParsedDocument(doc);
}

async function printSummary(): Promise<void> {
  const rows = [
    { entity: 'users', count: await prisma.user.count() },
    { entity: 'customers', count: await prisma.customer.count() },
    { entity: 'orders', count: await prisma.order.count() },
    { entity: 'tickets', count: await prisma.ticket.count() },
    { entity: 'ticket_expectations', count: await prisma.ticketExpectation.count() },
    { entity: 'tool_definitions', count: await prisma.toolDefinition.count() },
    { entity: 'eval_cases', count: await prisma.evalCase.count() },
    { entity: 'knowledge_documents', count: await prisma.knowledgeDocument.count() },
    { entity: 'knowledge_chunks', count: await prisma.knowledgeChunk.count() },
    { entity: 'quarantined_documents', count: await prisma.knowledgeDocument.count({ where: { quarantined: true } }) },
  ];
  console.table(rows);
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  console.log(`Seeding TrustDesk from ${DATA_DIR}${reset ? ' (reset first)' : ''}`);

  if (reset) await resetDatabase();

  await seedUsers();
  await seedCustomers();
  await seedOrders();
  await seedTickets();
  await seedToolDefinitions();
  await seedEvalCases();
  await seedKnowledgeBase();

  await printSummary();
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
