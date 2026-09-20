// Response shapes of the TrustDesk API (server/src/modules/*/mappers.ts). snake_case, no envelope.
// Nothing here carries expected_* fields: the API never exposes them (rule R2).

export interface CustomerSummary {
  customer_id: string
  name: string
  tier: string
}

export interface Customer extends CustomerSummary {
  email: string
  country: string
  created_at: string
  verified: boolean
  tags: string[]
}

export interface OrderItem {
  sku?: string
  name?: string
  quantity?: number
  category?: string
  final_sale?: boolean
}

export interface Order {
  order_id: string
  customer_id: string
  status: string
  placed_at: string
  delivered_at: string | null
  eligible_return_until: string | null
  total: number
  currency: string
  payment_status: string
  tracking_number: string
  items: OrderItem[]
}

export interface TriageSummary {
  category: string
  priority: string
  should_escalate: boolean
}

export interface Triage extends TriageSummary {
  sentiment: string
  reason_summary: string
  run_id: string
  created_at: string
}

export interface FiredRule {
  rule: string
  matched_terms: string[]
  applied: boolean
}

export interface TriageResponse extends TriageSummary {
  ticket_id: string
  sentiment: string
  reason_summary: string
  run_id: string
  fired_rules: FiredRule[]
}

export interface TicketListItem {
  ticket_id: string
  subject: string
  channel: string
  status: string
  created_at: string
  customer: CustomerSummary
  latest_triage: TriageSummary | null
}

export interface Page<T> {
  items: T[]
  page: number
  page_size: number
  total: number
}

export interface PolicyContext {
  as_of: string
  return_window: { eligible: boolean; reason: string; window_ends_at: string | null } | null
  warranty: {
    covered: boolean
    months_since_delivery: number | null
    window_months: number
    extension_applied: boolean
    reason: string
  } | null
}

export interface DraftSummary {
  draft_id: string
  status: string
  created_at: string
  citations: string[]
}

export interface TicketDetail {
  ticket_id: string
  customer_id: string
  order_id: string | null
  channel: string
  subject: string
  body: string
  created_at: string
  status: string
  customer: Customer
  order: Order | null
  latest_triage: Triage | null
  drafts: DraftSummary[]
  tool_action_requests: ToolAction[]
  policy_context: PolicyContext
}

export interface Recommendation {
  tool_name: string
  reason: string
  requires_human_approval: boolean
}

export interface Approval {
  approval_id: string
  action_id: string | null
  draft_id: string | null
  reviewer_id: string
  decision: string
  reason: string
  created_at: string
}

export interface Draft {
  draft_id: string
  ticket_id: string
  status: string
  body: string
  citations: string[]
  recommended_actions: Recommendation[]
  run_id: string
  guardrail_outcome: string | null
  confidence: string | null
  refusal_reason: string | null
  created_at: string
}

export interface DraftDetail extends Draft {
  approvals: Approval[]
}

export type DraftPatch =
  | { status: 'edited'; body: string }
  | { status: 'approved' }
  | { status: 'rejected'; reason: string }
  | { status: 'sent' }

export interface ToolAction {
  action_id: string
  ticket_id: string
  tool_name: string
  payload: Record<string, unknown>
  risk_level: string
  requires_human_approval: boolean
  status: string
  idempotency_key: string
  requested_by: string
  result: unknown | null
  created_at: string
  executed_at: string | null
}

export interface ToolActionDetail extends ToolAction {
  idempotent_replay: boolean
  approvals: Approval[]
}

export interface ToolCatalogItem {
  tool_name: string
  description: string
  risk_level: string
  requires_human_approval: boolean
  allowed_categories: string[]
  required_fields: string[]
  max_amount_inr: number | null
}

export interface AgentRun {
  run_id: string
  ticket_id: string | null
  run_type: string
  status: string
  retrieved_doc_ids: string[]
  tool_calls: unknown
  guardrail_results: unknown
  model_provider: string | null
  model_name: string | null
  prompt_version: string | null
  latency_ms: number | null
  token_usage: unknown | null
  cost_estimate: number | null
  created_at: string
}

export interface DocumentListItem {
  doc_id: string
  title: string
  version: string
  audience: string
  trust_level: string
  quarantined: boolean
  chunk_count: number
}

export interface DocumentDetail extends DocumentListItem {
  source_path: string
  checksum: string
  updated_at: string
  content: string
  chunks: Array<{ chunk_id: string; ordinal: number; heading: string | null; content: string }>
}

export type EvalProvider = 'mock' | 'openrouter'
export type EvalRunStatus = 'running' | 'completed' | 'failed'

export interface EvalMetrics {
  category_accuracy: number
  priority_accuracy: number
  triage_accuracy: number
  citation_coverage: number
  unsafe_action_block_rate: number
  allowed_action_recall: number
  escalation_accuracy: number
  answer_requirement_coverage: number
}

export interface AnswerRequirementResult {
  requirement: string
  satisfied: boolean
  check_method: 'deterministic' | 'proxy' | 'missing'
}

export interface EvalCaseResult {
  case_id: string
  ticket_id: string
  passed: boolean
  predicted_category: string
  predicted_priority: string
  citations: string[]
  recommended_actions: string[]
  blocked_actions: string[]
  should_escalate: boolean
  notes: string
  answer_requirements: AnswerRequirementResult[]
}

export interface EvalCaseDetail {
  case_id: string
  guardrail_outcome: string | null
  refusal_reason: string | null
  executed_disallowed_actions: string[]
  draft_body_excerpt: string
  duration_ms: number
  eval_case_run_id: string
}

export interface AdversarialSummary {
  case_id: string
  safe: boolean
  unsafe_instruction_followed: boolean
  disallowed_action_executed: boolean
  escalated: boolean
  notes: string
}

export interface EvalRun {
  eval_run_id: string
  status: EvalRunStatus
  total_cases: number
  provider: EvalProvider
  started_at: string
  completed_at: string | null
  metrics: EvalMetrics | null
  case_results: EvalCaseResult[]
  case_details: EvalCaseDetail[]
  adversarial_summary: AdversarialSummary[]
  run_metadata: {
    model_names: string[]
    prompt_versions: string[]
    case_ids: string[]
    duration_ms: number | null
    report_error: string | null
  }
  error: string | null
}

export interface Feedback {
  feedback_id: string
  ticket_id: string
  draft_id: string | null
  rating: number
  reason: string | null
  corrected_response: string | null
  created_at: string
}

export interface ProbeResult {
  input_scan: { source: string; flagged: boolean; categories: string[]; matches: Array<{ group: string; term: string }>; severity: string }
  fired_rules: FiredRule[]
  decision: { outcome: string; reasons: string[]; required_citations: string[]; refusal_template: string | null }
  refusal_preview: string | null
  would_call_model: boolean
  persisted: false
}

export interface FlaggedRun {
  run_id: string
  ticket_id: string | null
  run_type: string
  status: string
  created_at: string
  severity: string
  pattern_groups: string[]
  matched_terms: Array<{ group: string; term: string }>
  outcome: string | null
  refusal_template: string | null
  model_provider: string | null
}

export interface LatencyStats {
  count: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
}

export interface MetricsSummary {
  generated_at: string
  window: { since: string | null; ticket_id: string | null }
  runs_total: number
  runs_by_type: Record<string, number>
  runs_by_status: Record<string, number>
  latency: LatencyStats & { by_type: Record<string, LatencyStats> }
  tokens: { prompt: number; completion: number; total: number; runs_with_usage: number; by_model: Record<string, { prompt: number; completion: number; runs: number }> }
  estimated_cost_usd: { total: number; runs_priced: number; runs_unpriced: number; by_model: Record<string, number> }
  pricing: { source: 'default' | 'env'; models: string[]; note: string }
}

export interface EvalRunSummary {
  eval_run_id: string
  status: EvalRunStatus
  provider: EvalProvider
  total_cases: number
  started_at: string
  completed_at: string | null
  metrics: EvalMetrics | null
  error: string | null
}
