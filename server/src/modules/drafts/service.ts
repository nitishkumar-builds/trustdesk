import type { AgentRun, Customer, Order, Prisma, Ticket, TriageResult } from '@prisma/client';
import { getAiAdapter, mergeResponses, type AiAdapter, type AiProviderName, type AiResponse } from '../../ai/index.js';
import { extractDraftFacts, mockDraft, type TriageJson } from '../../ai/mockAdapter.js';
import * as draftPrompt from '../../ai/prompts/draftReply.v1.js';
import { newId } from '../../db/ids.js';
import { prisma } from '../../db/prisma.js';
import { returnWindowStatus, toPolicyOrder } from '../../domain/policyWindows.js';
import { AppError, conflictError, guardrailError, notFoundError, validationError } from '../../errors/AppError.js';
import { assessDocuments, type DocumentFinding } from '../../guardrails/documentTrust.js';
import { scanUntrustedInput, type InputScanResult } from '../../guardrails/inputScanner.js';
import { scanDraftOutput } from '../../guardrails/outputScanner.js';
import { decideGuardrailOutcome, type GuardrailDecision } from '../../guardrails/policy.js';
import { refusalBody } from '../../guardrails/refusalTemplates.js';
import type { Principal } from '../../middleware/auth.js';
import { searchKnowledge } from '../knowledge/search.js';
import { mapOrder } from '../orders/mappers.js';
import { buildPolicyContext } from '../tickets/service.js';
import { applyPostRules } from '../triage/postRules.js';
import { triageTicket } from '../triage/service.js';
import { mapDraft, mapDraftDetail, type DraftDetailDto, type DraftDto } from './mappers.js';
import {
  applyRecommendationRules,
  ESCALATE_TOOL,
  shippingCaseFacts,
  type CaseRuleContext,
  type ProposedAction,
} from './recommendationRules.js';
import { draftOutputSchema, DRAFT_JSON_SCHEMA, type DraftOutput, type PatchDraftBody } from './schemas.js';

const RETRIEVAL_LIMIT = 5;

export interface DraftOptions {
  /** Used by the eval runner to force a provider; defaults to env.AI_PROVIDER. */
  provider?: AiProviderName;
  /** A ready adapter (the eval runner wraps the real one to observe prompt payloads); wins over provider. */
  adapter?: AiAdapter;
  /** Retrieval mode override (default env.RETRIEVAL_MODE); the eval runner compares fts vs hybrid. */
  retrievalMode?: 'fts' | 'hybrid';
}

type TicketWithContext = Ticket & { customer: Customer; order: Order | null };

interface TriageFacts {
  result: TriageResult;
  json: TriageJson;
  safetyCase: boolean;
}

// ---------------------------------------------------------------------------
// generateDraft — the Phase 6 pipeline
// ---------------------------------------------------------------------------

export async function generateDraft(ticketId: string, principal: Principal, options: DraftOptions = {}): Promise<DraftDto> {
  // 1. Load ticket, customer, order; policy facts as of the ticket's created_at (rule R1).
  const ticket = await loadTicket(ticketId);
  const policyContext = buildPolicyContext(ticket);
  const customerText = `${ticket.subject}\n${ticket.body}`;

  // 2. Latest triage, or run one now and reuse it.
  const triage = await ensureTriage(ticket, principal, options);

  // 3. Scan the customer message (never rewritten).
  const inputScan = scanUntrustedInput(customerText, 'customer_message');

  // 4. Retrieve with the triage category as the prior.
  const { results: retrieved, mode: retrievalMode } = await searchKnowledge({
    query: `${ticket.subject} ${ticket.body}`,
    categoryHint: triage.result.category,
    limit: RETRIEVAL_LIMIT,
    mode: options.retrievalMode,
  });
  const retrievedDocIds = unique(retrieved.map((r) => r.doc_id));

  // 5. Document trust: only safe chunks go anywhere near the model or the citations.
  const { safeChunks, findings: documentFindings } = assessDocuments(retrieved);
  const safeDocIds = unique(safeChunks.map((c) => c.doc_id));

  // 6. Guardrail decision.
  const guardrail = decideGuardrailOutcome({
    inputScan,
    documentFindings,
    triage: { shouldEscalate: triage.result.shouldEscalate, category: triage.result.category },
  });

  const tools = await prisma.toolDefinition.findMany({ orderBy: { toolName: 'asc' } });
  const caseCtx = await buildCaseRuleContext({ ticket, triage, guardrailOutcome: guardrail.outcome });
  // Required citations are grounded by policy definition, so they are allowed even when the
  // retrieval did not surface them (CLAUDE.md D-042).
  const allowedDocIds = unique([...safeDocIds, ...guardrail.requiredCitations]);

  const notes: string[] = [];
  let body: string;
  let citations: string[];
  let proposed: ProposedAction[];
  let confidence: DraftOutput['confidence'];
  let refusalReason: string | null = null;
  let response: AiResponse | null = null;
  let modelOutput: DraftOutput | null = null;
  const adapter = options.adapter ?? getAiAdapter(options.provider);
  const started = Date.now();

  if (guardrail.outcome === 'refuse_and_escalate') {
    // 7a. Deterministic refusal: the model is never called.
    const template = guardrail.refusalTemplate ?? 'unsupported_policy_request';
    body = refusalBody(template);
    citations = unique([...guardrail.requiredCitations, ...safeDocIds]);
    proposed = [{ tool_name: ESCALATE_TOOL, reason: `Guardrail refusal: ${guardrail.reasons[0] ?? 'unsafe request'}` }];
    confidence = 'high';
    refusalReason = `${template}: ${guardrail.reasons.join('; ')}`;
    notes.push('model_not_called_refusal_template_used');
  } else {
    // 7b. Model-generated draft, validated, retried once, then deterministic fallback.
    const user = draftPrompt.buildUser({
      ticket,
      customer: ticket.customer,
      order: ticket.order ? mapOrder(ticket.order) : null,
      triage: {
        category: triage.result.category,
        priority: triage.result.priority,
        should_escalate: triage.result.shouldEscalate,
        reason_summary: triage.result.reasonSummary,
      },
      policyContext,
      retrieved: safeChunks,
      tools: tools.map((t) => ({
        tool_name: t.toolName,
        description: t.description,
        allowed_categories: t.allowedCategories,
        requires_human_approval: t.requiresHumanApproval,
      })),
    });

    try {
      const completed = await completeDraftWithValidation(adapter, user, notes, customerText);
      modelOutput = completed.json;
      response = completed.response;
    } catch (err) {
      // Rule R7: the run is traced even when the provider fails.
      await persistFailedRun({ ticket, retrievedDocIds, inputScan, documentFindings, guardrail, notes, adapter, err, started });
      throw err;
    }

    body = modelOutput.body;
    citations = modelOutput.citations;
    proposed = modelOutput.recommended_actions;
    confidence = modelOutput.confidence;
  }

  // 8. Post-generation output scan; an unsafe body is never returned.
  const outputScan = await scanDraftOutput({
    text: body,
    citations,
    allowedDocIds,
    ticket: { ticketId: ticket.ticketId, customerId: ticket.customerId },
    customer: { customerId: ticket.customer.customerId, name: ticket.customer.name, email: ticket.customer.email },
  });
  if (!outputScan.safe) {
    body = refusalBody('unsupported_policy_request');
    citations = citations.filter((c) => allowedDocIds.includes(c));
    proposed = [{ tool_name: ESCALATE_TOOL, reason: 'Draft failed the output safety scan; specialist review required.' }];
    confidence = 'low';
    refusalReason = `output_scan: ${outputScan.violations.filter((x) => x.severity === 'high').map((x) => x.code).join(', ')}`;
    notes.push('unsafe_output_replaced_with_refusal_template');
  }

  // 9. Required citations are always appended, de-duplicated, order preserved.
  citations = unique([...citations, ...guardrail.requiredCitations]);

  // Recommendation rules are authoritative over the model (rule R5).
  const { recommendations, stripped } = applyRecommendationRules(proposed, caseCtx, tools);
  if (guardrail.outcome !== 'allow' && !recommendations.some((r) => r.tool_name === ESCALATE_TOOL)) {
    // A non-allow outcome always carries the escalation recommendation (CLAUDE.md D-043).
    const escalate = tools.find((t) => t.toolName === ESCALATE_TOOL);
    recommendations.push({
      tool_name: ESCALATE_TOOL,
      reason: `Guardrail outcome ${guardrail.outcome}: ${guardrail.reasons[0] ?? 'human review required'}`,
      requires_human_approval: escalate?.requiresHumanApproval ?? false,
    });
  }
  // The prompt requires the draft to state ineligibility on a not-eligible refund case. A model
  // may forget; the statement is appended deterministically and grounded in KB-REFUND-001 (D-048).
  if (caseCtx.returnWindow && !caseCtx.returnWindow.eligible && caseCtx.category === 'refund' && !/not eligible|final sale/i.test(body)) {
    body = `${body.trimEnd()}\n\nPlease note: under our refund policy this item is not eligible for a refund or return (${describeIneligibility(caseCtx.returnWindow.reason)}).`;
    if (allowedDocIds.includes('KB-REFUND-001') && !citations.includes('KB-REFUND-001')) citations = [...citations, 'KB-REFUND-001'];
    notes.push('not_eligible_statement_appended');
  }

  // 10. Persist the draft and its trace (rule R7).
  const runId = newId('run');
  const draftId = newId('draft');
  const guardrailResults = {
    input_scan: inputScan,
    document_findings: documentFindings,
    decision: decisionForTrace(guardrail),
    output_scan: outputScan,
    recommendation_rules: { proposed, stripped },
    case_context: caseContextForTrace(caseCtx),
    confidence,
    notes,
    triage_run_id: triage.result.runId,
    model_output: modelOutput,
    retrieval_mode: retrievalMode,
  };

  await prisma.$transaction([
    prisma.agentRun.create({
      data: {
        runId,
        ticketId: ticket.ticketId,
        runType: 'draft_reply',
        status: 'completed',
        retrievedDocIds,
        toolCalls: recommendations as unknown as Prisma.InputJsonArray,
        guardrailResults: guardrailResults as unknown as Prisma.InputJsonObject,
        modelProvider: response?.modelProvider ?? (guardrail.outcome === 'refuse_and_escalate' ? 'none' : adapter.name),
        modelName: response?.modelName || null,
        promptVersion: draftPrompt.version,
        latencyMs: response?.latencyMs ?? Date.now() - started,
        tokenUsage: response?.tokenUsage ? (response.tokenUsage as Prisma.InputJsonObject) : undefined,
        costEstimate: response?.costEstimate ?? null,
      },
    }),
    prisma.draftReply.create({
      data: {
        draftId,
        ticketId: ticket.ticketId,
        status: 'generated',
        body,
        citations,
        recommendedActions: recommendations as unknown as Prisma.InputJsonArray,
        refusalReason,
        runId,
      },
    }),
  ]);

  const draft = await prisma.draftReply.findUniqueOrThrow({ where: { draftId } });
  const run = await prisma.agentRun.findUnique({ where: { runId } });
  return mapDraft(draft, run);
}

// ---------------------------------------------------------------------------
// Case context (shared with Phase 7's execution gate)
// ---------------------------------------------------------------------------

export async function buildCaseRuleContext(input: {
  ticket: TicketWithContext;
  triage: TriageFacts;
  guardrailOutcome: GuardrailDecision['outcome'];
}): Promise<CaseRuleContext> {
  const { ticket, triage } = input;
  const carrierConfirmed = await hasCarrierConfirmation(ticket.ticketId);
  return {
    category: triage.result.category,
    guardrailOutcome: input.guardrailOutcome,
    safetyCase: triage.safetyCase,
    // Rule R1: asOf is the ticket's created_at.
    returnWindow: ticket.order ? returnWindowStatus({ order: toPolicyOrder(ticket.order), asOf: ticket.createdAt }) : null,
    shipping: shippingCaseFacts({ order: ticket.order, asOf: ticket.createdAt, carrierConfirmed }),
  };
}

/** Recomputes the full case context for a ticket from persisted state (used by Phase 7). */
export async function caseRuleContextForTicket(ticketId: string, principal: Principal): Promise<CaseRuleContext> {
  const ticket = await loadTicket(ticketId);
  const triage = await ensureTriage(ticket, principal);
  const inputScan = scanUntrustedInput(`${ticket.subject}\n${ticket.body}`, 'customer_message');
  const guardrail = decideGuardrailOutcome({
    inputScan,
    documentFindings: [],
    triage: { shouldEscalate: triage.result.shouldEscalate, category: triage.result.category },
  });
  return buildCaseRuleContext({ ticket, triage, guardrailOutcome: guardrail.outcome });
}

// An executed carrier investigation whose (simulated) result confirms loss lifts the stale-tracking gate.
async function hasCarrierConfirmation(ticketId: string): Promise<boolean> {
  const actions = await prisma.toolActionRequest.findMany({
    where: { ticketId, toolName: 'open_carrier_investigation', status: 'executed' },
    select: { result: true },
  });
  return actions.some((a) => {
    const r = a.result as { carrier_confirmed_lost?: unknown } | null;
    return r?.carrier_confirmed_lost === true;
  });
}

// ---------------------------------------------------------------------------
// Draft lifecycle (Good-To-Have, built here because it is cheap)
// ---------------------------------------------------------------------------

export async function listDraftsForTicket(ticketId: string): Promise<{ items: DraftDto[]; total: number }> {
  const ticket = await prisma.ticket.findUnique({ where: { ticketId }, select: { ticketId: true } });
  if (!ticket) throw notFoundError(`Ticket ${ticketId} not found`);
  const drafts = await prisma.draftReply.findMany({ where: { ticketId }, orderBy: { createdAt: 'desc' } });
  const runs = await runsById(drafts.map((d) => d.runId));
  return { items: drafts.map((d) => mapDraft(d, runs.get(d.runId) ?? null)), total: drafts.length };
}

export async function getDraft(draftId: string): Promise<DraftDetailDto> {
  const draft = await prisma.draftReply.findUnique({
    where: { draftId },
    include: { approvals: { orderBy: { createdAt: 'asc' } } },
  });
  if (!draft) throw notFoundError(`Draft ${draftId} not found`);
  const run = await prisma.agentRun.findUnique({ where: { runId: draft.runId } });
  return mapDraftDetail(draft, run);
}

// Legal transitions. Terminal states (sent, rejected) accept nothing.
const TRANSITIONS: Record<PatchDraftBody['status'], readonly string[]> = {
  edited: ['generated', 'edited', 'approved'],
  approved: ['generated', 'edited'],
  rejected: ['generated', 'edited', 'approved'],
  sent: ['approved'],
};

export async function patchDraft(draftId: string, body: PatchDraftBody, principal: Principal): Promise<DraftDetailDto> {
  const draft = await prisma.draftReply.findUnique({ where: { draftId }, include: { ticket: { include: { customer: true } } } });
  if (!draft) throw notFoundError(`Draft ${draftId} not found`);

  const allowedFrom = TRANSITIONS[body.status];
  if (!allowedFrom.includes(draft.status)) {
    throw conflictError(`Draft ${draftId} is ${draft.status}; it cannot move to ${body.status}`, {
      current_status: draft.status,
      requested_status: body.status,
      allowed_from: allowedFrom,
    });
  }
  if (body.status === 'edited' && !body.body) {
    throw validationError('An edited draft needs a body', { field: 'body' });
  }
  if (body.status !== 'edited' && body.body !== undefined) {
    // The text that is approved must be the text that is sent: body changes only via 'edited',
    // which requires a fresh approval (D-045).
    throw validationError(`A body can only be supplied with status "edited", not "${body.status}"`, { field: 'body' });
  }
  if (body.status === 'rejected' && !body.reason) {
    throw validationError('A rejection needs a reason', { field: 'reason' });
  }

  // Rule R8 also covers human edits: an edited body must pass the same output scan.
  if (body.body !== undefined && body.body !== draft.body) {
    const scan = await scanDraftOutput({
      text: body.body,
      citations: draft.citations,
      allowedDocIds: draft.citations,
      ticket: { ticketId: draft.ticketId, customerId: draft.ticket.customerId },
      customer: { customerId: draft.ticket.customer.customerId, name: draft.ticket.customer.name, email: draft.ticket.customer.email },
    });
    if (!scan.safe) {
      throw guardrailError('The edited draft failed the output safety scan', {
        violations: scan.violations.filter((v) => v.severity === 'high'),
      });
    }
  }

  // The transition is applied as a conditional update inside the transaction, so two concurrent
  // approvals cannot both succeed: the second one finds the status already moved and gets 409.
  await prisma.$transaction(async (tx) => {
    const moved = await tx.draftReply.updateMany({
      where: { draftId, status: { in: [...allowedFrom] } },
      data: { status: body.status, ...(body.body !== undefined ? { body: body.body } : {}) },
    });
    if (moved.count === 0) {
      const current = await tx.draftReply.findUnique({ where: { draftId }, select: { status: true } });
      throw conflictError(`Draft ${draftId} is ${current?.status ?? 'missing'}; it cannot move to ${body.status}`, {
        current_status: current?.status ?? null,
        requested_status: body.status,
        allowed_from: allowedFrom,
      });
    }
    if (body.status === 'approved' || body.status === 'rejected') {
      await tx.approval.create({
        data: {
          approvalId: newId('approval'),
          draftId,
          reviewerId: principal.userId,
          decision: body.status,
          reason: body.reason ?? (body.status === 'approved' ? 'Approved by reviewer' : 'Rejected by reviewer'),
        },
      });
    }
  });
  return getDraft(draftId);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadTicket(ticketId: string): Promise<TicketWithContext> {
  const ticket = await prisma.ticket.findUnique({ where: { ticketId }, include: { customer: true, order: true } });
  if (!ticket) throw notFoundError(`Ticket ${ticketId} not found`);
  return ticket;
}

async function ensureTriage(ticket: TicketWithContext, principal: Principal, options: DraftOptions = {}): Promise<TriageFacts> {
  let result = await prisma.triageResult.findFirst({ where: { ticketId: ticket.ticketId }, orderBy: { createdAt: 'desc' } });
  if (!result) {
    await triageTicket(ticket.ticketId, principal, { provider: options.provider, adapter: options.adapter, retrievalMode: options.retrievalMode });
    result = await prisma.triageResult.findFirstOrThrow({ where: { ticketId: ticket.ticketId }, orderBy: { createdAt: 'desc' } });
  }
  const json: TriageJson = {
    category: result.category as TriageJson['category'],
    priority: result.priority as TriageJson['priority'],
    sentiment: result.sentiment as TriageJson['sentiment'],
    should_escalate: result.shouldEscalate,
    reason_summary: result.reasonSummary,
  };
  // PR1 is a pure function of the customer text, so "fired in triage" is recomputed here rather
  // than read back from the trace (CLAUDE.md D-041).
  const { fired } = applyPostRules(`${ticket.subject}\n${ticket.body}`, json);
  const safetyCase = fired.some((f) => f.rule === 'PR1_safety' && f.applied);
  return { result, json, safetyCase };
}

async function completeDraftWithValidation(
  adapter: AiAdapter,
  user: string,
  notes: string[],
  customerText: string,
): Promise<{ json: DraftOutput; response: AiResponse | null }> {
  // Every attempt's response is kept so the trace reports the tokens and cost of the whole call (D-074).
  const responses: AiResponse[] = [];
  const attempt = async (extraSystem: string): Promise<DraftOutput | null> => {
    const response = await adapter.complete({
      promptVersion: draftPrompt.version,
      system: extraSystem ? `${draftPrompt.system}\n\n${extraSystem}` : draftPrompt.system,
      user,
      jsonSchema: DRAFT_JSON_SCHEMA,
      temperature: 0.2,
      maxTokens: 1200,
    });
    responses.push(response);
    const parsed = draftOutputSchema.safeParse(response.json);
    if (parsed.success) return parsed.data;
    notes.push(`model_output_invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return null;
  };

  const first = await attempt('');
  if (first) return { json: first, response: mergeResponses(responses) };
  const second = await attempt(
    'Your previous answer was not valid JSON with the required keys. Answer again with ONLY the JSON object: body, citations, recommended_actions, confidence.',
  );
  if (second) {
    notes.push('model_output_retry_succeeded');
    return { json: second, response: mergeResponses(responses) };
  }
  notes.push('model_output_invalid_fallback_applied');
  const merged = mergeResponses(responses);
  return { json: mockDraft(customerText, extractDraftFacts(user)).json, response: merged ? { ...merged, modelName: '' } : null };
}

async function persistFailedRun(input: {
  ticket: TicketWithContext;
  retrievedDocIds: string[];
  inputScan: InputScanResult;
  documentFindings: DocumentFinding[];
  guardrail: GuardrailDecision;
  notes: string[];
  adapter: AiAdapter;
  err: unknown;
  started: number;
}): Promise<void> {
  const message = input.err instanceof AppError ? `${input.err.code}: ${input.err.message}` : String(input.err);
  await prisma.agentRun.create({
    data: {
      runId: newId('run'),
      ticketId: input.ticket.ticketId,
      runType: 'draft_reply',
      status: 'failed',
      retrievedDocIds: input.retrievedDocIds,
      toolCalls: [],
      guardrailResults: {
        input_scan: input.inputScan,
        document_findings: input.documentFindings,
        decision: decisionForTrace(input.guardrail),
        notes: [...input.notes, `provider_error: ${message}`],
      } as unknown as Prisma.InputJsonObject,
      modelProvider: input.adapter.name,
      promptVersion: draftPrompt.version,
      latencyMs: Date.now() - input.started,
    },
  });
}

// Stored traces are API output (GET /api/agent-runs), so their keys are snake_case (D-003).
function decisionForTrace(d: GuardrailDecision) {
  return { outcome: d.outcome, reasons: d.reasons, required_citations: d.requiredCitations, refusal_template: d.refusalTemplate };
}

function caseContextForTrace(c: CaseRuleContext) {
  return {
    category: c.category,
    guardrail_outcome: c.guardrailOutcome,
    safety_case: c.safetyCase,
    return_window: c.returnWindow
      ? { eligible: c.returnWindow.eligible, reason: c.returnWindow.reason, window_ends_at: c.returnWindow.windowEndsAt?.toISOString() ?? null }
      : null,
    shipping: c.shipping
      ? {
          delivered: c.shipping.delivered,
          business_days_since_dispatch: c.shipping.businessDaysSinceDispatch,
          carrier_confirmed: c.shipping.carrierConfirmed,
          stale_tracking_under_threshold: c.shipping.staleTrackingUnderThreshold,
        }
      : null,
  };
}

async function runsById(runIds: string[]): Promise<Map<string, AgentRun>> {
  if (runIds.length === 0) return new Map();
  const runs = await prisma.agentRun.findMany({ where: { runId: { in: runIds } } });
  return new Map(runs.map((r) => [r.runId, r]));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function describeIneligibility(reason: string): string {
  switch (reason) {
    case 'final_sale':
      return 'it was sold as a final sale item';
    case 'non_returnable_category':
      return 'software licenses and downloadable products are non-returnable';
    case 'window_expired':
      return 'the 7-day return window has passed';
    case 'not_delivered':
      return 'the order has not been delivered yet';
    default:
      return reason.replace(/_/g, ' ');
  }
}
