// Typed fetch wrapper: bearer token from localStorage ('trustdesk_token'), the standard error
// envelope parsed into ApiError, and one helper per endpoint the pages use.
import type {
  AgentRun,
  DocumentDetail,
  DocumentListItem,
  Draft,
  DraftDetail,
  DraftPatch,
  EvalProvider,
  EvalRun,
  EvalRunSummary,
  Feedback,
  FlaggedRun,
  MetricsSummary,
  Page,
  ProbeResult,
  TicketDetail,
  TicketListItem,
  ToolActionDetail,
  ToolCatalogItem,
  TriageResponse,
} from './types.ts'

export const TOKEN_KEY = 'trustdesk_token'
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly requestId: string | null

  constructor(status: number, code: string, message: string, details: unknown = null, requestId: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

// The token used for requests lives in memory and is mirrored to localStorage; every request
// reads the in-memory copy, so the header label and the Authorization header can never diverge
// (and a browser with blocked storage still sends the token).
let activeToken = ''
try {
  activeToken = localStorage.getItem(TOKEN_KEY) ?? ''
} catch {
  activeToken = ''
}

export function readToken(): string {
  return activeToken
}

export function writeToken(token: string): void {
  activeToken = token
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // private mode / blocked storage: the in-memory token still applies to every request
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown; request_id?: string }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = readToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', `Could not reach the API: ${err instanceof Error ? err.message : String(err)}`)
  }

  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!res.ok) {
    const env = (json ?? {}) as ErrorEnvelope
    if (env.error?.code) {
      throw new ApiError(res.status, env.error.code, env.error.message ?? res.statusText, env.error.details ?? null, env.error.request_id ?? null)
    }
    throw new ApiError(res.status, `HTTP_${res.status}`, text.slice(0, 200) || res.statusText)
  }
  return { status: res.status, data: json as T }
}

const get = <T,>(path: string) => call<T>('GET', path).then((r) => r.data)
const post = <T,>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}).then((r) => r.data)
const patch = <T,>(path: string, body: unknown) => call<T>('PATCH', path, body).then((r) => r.data)

const enc = encodeURIComponent
/** Server maximum for GET /api/agent-runs; the ticket page says "newest N" when a ticket has more. */
export const RUNS_LIMIT = 200

export const api = {
  listTickets: (status?: string) => get<Page<TicketListItem>>(`/tickets?pageSize=100${status ? `&status=${enc(status)}` : ''}`),
  getTicket: (ticketId: string) => get<TicketDetail>(`/tickets/${enc(ticketId)}`),
  runTriage: (ticketId: string) => post<TriageResponse>(`/tickets/${enc(ticketId)}/triage`),
  generateDraft: (ticketId: string) => post<Draft>(`/tickets/${enc(ticketId)}/draft-reply`),
  listDrafts: (ticketId: string) => get<{ items: Draft[]; total: number }>(`/tickets/${enc(ticketId)}/drafts`),
  getDraft: (draftId: string) => get<DraftDetail>(`/drafts/${enc(draftId)}`),
  patchDraft: (draftId: string, body: DraftPatch) => patch<DraftDetail>(`/drafts/${enc(draftId)}`, body),

  toolCatalog: () => get<{ items: ToolCatalogItem[] }>('/tool-actions/catalog'),
  listActions: (ticketId: string) => get<{ items: ToolActionDetail[]; total: number }>(`/tool-actions?ticket_id=${enc(ticketId)}&limit=200`),
  // 201 = a new action; 200 = idempotent replay of an existing one (rule R6)
  requestAction: (body: { ticket_id: string; tool_name: string; payload: Record<string, unknown> }) =>
    call<ToolActionDetail>('POST', '/tool-actions', body).then((r) => ({ action: r.data, created: r.status === 201 })),
  decideAction: (actionId: string, decision: 'approved' | 'rejected', reason: string) =>
    post<ToolActionDetail>(`/tool-actions/${enc(actionId)}/approve`, { decision, reason }),
  executeAction: (actionId: string) => post<ToolActionDetail>(`/tool-actions/${enc(actionId)}/execute`),

  listRuns: (ticketId: string) => get<{ items: AgentRun[]; total: number }>(`/agent-runs?ticket_id=${enc(ticketId)}&limit=${RUNS_LIMIT}`),
  getRun: (runId: string) => get<AgentRun>(`/agent-runs/${enc(runId)}`),

  listDocuments: () => get<{ items: DocumentListItem[]; total: number }>('/documents'),
  getDocument: (docId: string) => get<DocumentDetail>(`/documents/${enc(docId)}`),

  startEvalRun: (provider: EvalProvider) => post<{ eval_run_id: string; status: 'running' }>('/eval-runs', { provider }),
  getEvalRun: (evalRunId: string) => get<EvalRun>(`/eval-runs/${enc(evalRunId)}`),
  listEvalRuns: () => get<{ items: EvalRunSummary[]; total: number }>('/eval-runs?limit=20'),

  metricsSummary: () => get<MetricsSummary>('/metrics/summary'),

  // Phase 11 item 5: red-team view
  probe: (text: string) => post<ProbeResult>('/red-team/probe', { text }),
  listFlaggedRuns: (offset = 0) => get<{ items: FlaggedRun[]; total: number; limit: number; offset: number }>(`/red-team/runs?limit=100&offset=${offset}`),

  // Phase 11 item 4: JWT login (the demo-token buttons keep working as a fallback)
  login: (email: string, password: string) =>
    post<{ token: string; token_type: 'Bearer'; expires_in: number; user: { user_id: string; email: string; name: string; role: string } }>('/auth/login', { email, password }),

  listFeedback: (ticketId: string) => get<{ items: Feedback[]; total: number; average_rating: number | null }>(`/feedback?ticket_id=${enc(ticketId)}`),
  createFeedback: (body: { ticket_id: string; draft_id?: string; rating: number; reason?: string; corrected_response?: string }) => post<Feedback>('/feedback', body),
}
