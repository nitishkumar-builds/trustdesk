import type { AgentRun, Approval, DraftReply } from '@prisma/client';
import type { Recommendation } from './recommendationRules.js';

export interface ApprovalDto {
  approval_id: string;
  action_id: string | null;
  draft_id: string | null;
  reviewer_id: string;
  decision: string;
  reason: string;
  created_at: string;
}

// docs/API_CONTRACT.md section 6 plus guardrail_outcome, confidence, refusal_reason, created_at.
export interface DraftDto {
  draft_id: string;
  ticket_id: string;
  status: string;
  body: string;
  citations: string[];
  recommended_actions: Recommendation[];
  run_id: string;
  guardrail_outcome: string | null;
  confidence: string | null;
  refusal_reason: string | null;
  created_at: string;
}

export interface DraftDetailDto extends DraftDto {
  approvals: ApprovalDto[];
}

interface RunGuardrailSummary {
  decision?: { outcome?: string };
  confidence?: string;
}

export function mapApproval(a: Approval): ApprovalDto {
  return {
    approval_id: a.approvalId,
    action_id: a.actionId,
    draft_id: a.draftId,
    reviewer_id: a.reviewerId,
    decision: a.decision,
    reason: a.reason,
    created_at: a.createdAt.toISOString(),
  };
}

// guardrail_outcome and confidence live on the draft's AgentRun (the DraftReply schema is fixed).
export function mapDraft(d: DraftReply, run: AgentRun | null): DraftDto {
  const g = (run?.guardrailResults ?? {}) as RunGuardrailSummary;
  return {
    draft_id: d.draftId,
    ticket_id: d.ticketId,
    status: d.status,
    body: d.body,
    citations: d.citations,
    recommended_actions: Array.isArray(d.recommendedActions) ? (d.recommendedActions as unknown as Recommendation[]) : [],
    run_id: d.runId,
    guardrail_outcome: g.decision?.outcome ?? null,
    confidence: g.confidence ?? null,
    refusal_reason: d.refusalReason,
    created_at: d.createdAt.toISOString(),
  };
}

export function mapDraftDetail(d: DraftReply & { approvals: Approval[] }, run: AgentRun | null): DraftDetailDto {
  return { ...mapDraft(d, run), approvals: d.approvals.map(mapApproval) };
}
