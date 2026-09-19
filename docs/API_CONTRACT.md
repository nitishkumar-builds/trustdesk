# TrustDesk API Contract

This document describes the expected product and API behavior without requiring any specific programming language or framework.

You may change route names, request shapes, or response shapes if you document the changes clearly. Your implementation should still support the flows below.

## Optional Roles

- `support_agent`: Reviews tickets, drafts, and non-admin tool actions.
- `support_manager`: Approves sensitive actions and goodwill exceptions.
- `admin`: Manages knowledge-base ingestion, model configuration, eval runs, and audit logs.

Full role-based access control is Good To Have. For Must Have, a simple demo token or login flow is enough.

## Core Resources

- Customer
- Order
- Ticket
- Knowledge document
- Draft reply
- Tool action request
- Approval
- Agent run trace
- Eval run

Good To Have resources:

- Feedback
- User roles and permissions

## Authentication

Implement a simple authentication mechanism for the chosen stack.

Minimum expectation:

- Login or token-based API access.
- Basic protection so APIs are not completely open.

Good To Have:

- Role-aware authorization.
- Organization or tenant scoping.

## Core API Flows

### 1. Ingest Knowledge Documents

Expected behavior:

- Accept one or more documents.
- Store document metadata and content.
- Prepare the document for retrieval.
- Preserve source document IDs such as `KB-REFUND-001`.

Example request:

```json
{
  "documents": [
    {
      "doc_id": "KB-REFUND-001",
      "title": "Refund and Return Policy",
      "content": "...",
      "source_path": "data/knowledge_base/refund_policy.md"
    }
  ]
}
```

Example response:

```json
{
  "ingested": 1,
  "document_ids": ["KB-REFUND-001"]
}
```

### 2. Search Knowledge Base

Expected behavior:

- Accept a natural-language query.
- Return ranked documents or chunks.
- Include document IDs, titles, snippets, and relevance scores if available.

Example response:

```json
{
  "query": "damaged item replacement",
  "results": [
    {
      "doc_id": "KB-REFUND-001",
      "title": "Refund and Return Policy",
      "snippet": "For damaged or defective items reported within the return window...",
      "score": 0.87
    }
  ]
}
```

### 3. List and Fetch Tickets

Expected behavior:

- List tickets from the provided seed data.
- Fetch a ticket by ID.
- Include or expose linked customer and order context.

### 4. Create Ticket

Expected behavior:

- Store incoming ticket details.
- Link customer and order when provided.
- Keep the original customer message unchanged for auditability.

Example request:

```json
{
  "customer_id": "cus_1001",
  "order_id": "ord_5001",
  "channel": "email",
  "subject": "Received damaged earbuds",
  "body": "My BlueBuds Air arrived with the left earbud cracked."
}
```

Creating new tickets is useful for demos, but Must Have can use the provided seed tickets.

### 5. Triage Ticket

Expected behavior:

- Classify category, priority, sentiment, and escalation need.
- Use retrieved context if useful.
- Store the triage output and trace.

Example response:

```json
{
  "ticket_id": "tkt_9001",
  "category": "refund",
  "priority": "medium",
  "sentiment": "frustrated",
  "should_escalate": false,
  "reason_summary": "Damaged physical product reported within the return window.",
  "run_id": "run_123"
}
```

### 6. Generate Draft Reply

Expected behavior:

- Retrieve relevant documents.
- Generate a grounded support draft.
- Include citations using document IDs.
- Refuse or escalate unsupported or unsafe requests.
- Store the draft and the agent run trace.

Example response:

```json
{
  "draft_id": "draft_123",
  "ticket_id": "tkt_9001",
  "status": "generated",
  "body": "I am sorry the BlueBuds Air arrived damaged...",
  "citations": ["KB-REFUND-001"],
  "recommended_actions": [
    {
      "tool_name": "create_replacement_order",
      "requires_human_approval": true,
      "reason": "Damaged physical item reported within return window."
    }
  ],
  "run_id": "run_124"
}
```

### 7. Approve Or Reject Draft

Good To Have behavior:

- Allow a support agent to approve, edit, or reject a draft.
- Store reviewer ID, timestamp, and reason.
- Only approved drafts may be sent.

### 8. Request Tool Action

Expected behavior:

- Validate the tool exists.
- Validate required fields.
- Validate that the tool is allowed for the ticket category.
- Enforce idempotency.
- Require human approval for sensitive actions.

Example action request:

```json
{
  "ticket_id": "tkt_9001",
  "tool_name": "create_replacement_order",
  "payload": {
    "order_id": "ord_5001",
    "sku": "BG-AIRPODS-01",
    "reason": "Damaged on arrival",
    "idempotency_key": "tkt_9001-replacement-1"
  }
}
```

### 9. Approve And Execute Tool Action

Expected behavior:

- Require a human approval step for the one sensitive action you implement.
- Store execution status and result.
- Preserve the idempotency key.

### 10. Fetch Agent Run Trace

Expected behavior:

- Fetch trace details for a triage or draft-generation run.
- Include ticket ID, run type, retrieved document IDs, recommended/requested tool actions, guardrail result, and final status.

### 11. Run Evaluations

Expected behavior:

- Run all or selected cases from `data/eval_cases.jsonl`.
- Report triage accuracy, citation coverage, allowed/disallowed action safety, and escalation behavior.
- Store eval run summaries.

Example response:

```json
{
  "eval_run_id": "eval_run_001",
  "total_cases": 8,
  "triage_accuracy": 0.875,
  "citation_coverage": 1.0,
  "unsafe_action_block_rate": 1.0,
  "escalation_accuracy": 0.875
}
```

## Good To Have Flows

These are useful but not required for Must Have:

- Draft edit/approve/reject lifecycle.
- Feedback submission and corrected responses.
- Full role-based authorization.
- Additional tool actions beyond the one required approval-gated action.
- Rich admin views for evals and traces.

## Error Handling

Use consistent API errors. At minimum, represent:

- Validation errors.
- Authentication failures.
- Authorization failures.
- Missing resources.
- Guardrail failures.
- Tool execution failures.
- AI provider failures or timeouts.

## Idempotency

Tool actions must use idempotency keys so retries do not create duplicate refunds, replacements, coupons, or escalations.

## Auditability

Every AI-generated answer, triage decision, retrieval result, tool recommendation, approval, and tool execution should be traceable to a ticket and reviewer or system actor where applicable.
