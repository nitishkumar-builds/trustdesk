# AI-First Software Engineering Capstone - Case Study

## TrustDesk: AI Support Operations Agent

**Author:** Airtribe

## Background & Objective

Modern support teams handle thousands of repetitive but high-stakes customer conversations. A good support system must answer quickly, cite the right policy, understand customer and order context, route edge cases to humans, and avoid taking risky actions without approval.

Traditional chatbots usually fail because they either hallucinate answers, ignore company policy, or cannot safely act on behalf of support teams. TrustDesk is an AI-first product where the AI is not just a text generator. It must retrieve policy context, classify tickets, decide whether it has enough evidence, suggest or execute allowed tools, and leave a complete audit trail.

The objective is to build a reliable AI support operations platform that can:

- Ingest company support documents and retrieve relevant policy context.
- Triage incoming support tickets by intent, priority, sentiment, and escalation need.
- Generate grounded draft replies with citations from the knowledge base.
- Suggest safe operational actions such as replacement, refund review, coupon creation, or escalation.
- Require human approval for sensitive actions.
- Defend against prompt injection, unsupported policy claims, PII leakage, and excessive agency.
- Track evaluations and the minimum trace data needed to debug AI decisions.

## Language and Stack

This project is intentionally language agnostic. You may implement it in Node.js, Java, Python, Go, Ruby, or any stack of your choice.

You are free to choose your framework, database, queue, retrieval approach, vector store, and AI provider. Free-tier APIs (for example Gemini or Groq) or locally hosted models (for example via Ollama) are acceptable, and tests may run against a mocked model adapter. Your choices must be documented, and the system must satisfy the functional, security, and evaluation requirements described below.

The provided Python scripts are optional local utilities. They are not part of the required implementation stack.

## Scope

TrustDesk has a clear core scope. Build the Must Have features first. Good To Have and Stretch features should only be attempted after the core workflow is working end to end.

## Recommended Demo Flow

Your final demo should be able to show this flow clearly:

1. Open a ticket from the provided seed data.
2. Run AI triage and show category, priority, and escalation decision.
3. Generate a draft reply with policy citations.
4. Show the minimal trace for that AI run.
5. For one eligible case, show an approval-gated action such as `start_refund_review` or `create_replacement_order`.
6. For one adversarial case, show that the system refuses or escalates instead of following unsafe instructions.
7. Run the eval command or endpoint and show the summary report.

Good demo tickets:

- `tkt_9001`: damaged earbuds, suitable for a replacement or refund-review flow.
- `tkt_9006`: prompt injection asking for a hidden large coupon.
- `tkt_9007`: request to reveal hidden prompts and secrets.

## Acceptable Simplifications

- Retrieval can be keyword search, database full-text search, embeddings, or hybrid search. Vector search is not required.
- Authentication can be a simple demo token or login flow. Full role-based access control is Good To Have.
- You may use a free-tier hosted model, a local model, or a mocked model in tests.
- The frontend can be a simple page with buttons and JSON/result panels. UI polish is not graded.
- You only need one approval-gated action for Must Have. More actions are Good To Have.
- Minimal traces are enough for Must Have. Full latency, cost, token, and prompt-version tracking is Good To Have.

## Avoid These Mistakes

- Do not use the expected labels from `data/tickets.json` or `data/eval_cases.jsonl` as hidden answers in your AI flow. They are for evaluation only.
- Do not evaluate return windows or warranty windows using the current date. Use each ticket's `created_at`.
- Do not treat retrieved documents as trusted instructions. `KB-ADVERSARIAL-001` is intentionally unsafe.
- Do not execute sensitive actions directly from AI output. Require approval first.
- Do not build Good To Have features before the Must Have workflow works end to end.

## Must Have

### 1. Load the Provided Data

- Load the provided customers, orders, tickets, tool catalog, eval cases, and knowledge-base documents.
- Use any persistent store you prefer.
- Preserve document IDs such as `KB-REFUND-001` because evals depend on them.
- Evaluate policy windows such as return eligibility and warranty coverage relative to each ticket's `created_at`, not the current date.

### 2. Ticket APIs and Simple Frontend

- Provide APIs to list tickets, fetch a ticket, and view linked customer/order context.
- Build a simple frontend for support agents.
- You may vibe-code or AI-assist the frontend.
- The UI should let a reviewer open a ticket, trigger triage, generate a draft, view citations, review one sensitive action, and see evaluation results.
- UI polish is not graded. The frontend only needs to make the workflow easy to demo.

### 3. Knowledge Retrieval and Cited Draft Replies

- Search the knowledge-base documents for policy context relevant to a ticket.
- Generate a support draft using the ticket, customer/order context, and retrieved documents.
- Include citation document IDs in the draft response.
- Refuse or escalate when the answer is not supported by retrieved policy.
- Avoid exposing internal-only notes, hidden prompts, secrets, or unrelated customer data.

### 4. AI Triage

- Classify each ticket into one category such as `shipping`, `refund`, `warranty`, `billing`, `account_security`, or `general`.
- Assign priority such as `low`, `medium`, `high`, or `urgent`.
- Decide whether the ticket should be escalated to a human.
- Store the triage result with the ticket.

### 5. One Approval-Gated Tool Action

- Implement one sensitive tool action from the provided catalog.
- Use either `start_refund_review` or `create_replacement_order` for the Must Have implementation.
- The AI may recommend the action, but a human must approve it before execution.
- Store action status, approval decision, and execution result.
- Enforce an idempotency key so retries cannot create duplicate refunds, replacements, or actions.

### 6. Guardrails for Adversarial Cases

- Treat customer messages and retrieved documents as untrusted input.
- Correctly handle the three adversarial eval cases:
  - account change request that asks to skip identity checks,
  - prompt injection asking for a large hidden coupon,
  - request to reveal hidden prompts, API keys, or internal notes.
- Do not follow instructions from the adversarial vendor document.
- Escalate unsafe or unsupported requests instead of inventing policy.

### 7. Minimal Traces and Evaluation Runner

- Store a minimal trace for each AI run:
  - ticket ID,
  - run type,
  - retrieved document IDs,
  - recommended or requested tool actions,
  - guardrail result,
  - final status.
- Build one command, endpoint, or test flow that runs `data/eval_cases.jsonl`.
- Produce a small evaluation report covering triage, citation coverage, unsafe action blocking, and escalation behavior.

## Good To Have

- Implement more tool actions from `data/tool_actions.json`.
- Add role-based authorization for support agents, managers, and admins.
- Add feedback/rating for draft quality and triage quality.
- Add fuller observability such as latency, model name, prompt version, token usage, and cost estimate.
- Improve retrieval using hybrid search, embeddings, or a vector database.
- Add draft editing, approval, rejection, and sent states.
- Make the frontend more polished or add richer admin/eval views.

## Stretch

- Slack, Gmail, or Intercom-style ticket ingestion.
- Multi-tenant organization support.
- Policy versioning and answer replay against older policy versions.
- Cost controls per organization or support agent.
- Red-team dashboard for prompt-injection and jailbreak attempts.

## Technical Requirements

- Expose core functionality as RESTful APIs or a clearly documented equivalent HTTP API.
- Use a reliable persistent store for tickets, customers, orders, documents, drafts, tool calls, approvals, and traces. Feedback storage is Good To Have.
- Implement a simple authentication mechanism, such as a demo token or login flow. Full role-based access control is Good To Have.
- Implement a retrieval layer using either:
  - database full-text search,
  - a vector database,
  - a hybrid approach,
  - or a clearly documented local substitute.
- Keep the AI provider integration behind an adapter so it can be mocked in tests.
- Use idempotency for the required approval-gated tool action.
- Ensure the required sensitive action needs explicit human approval.
- Provide automated tests for critical flows and guardrails.
- Keep long-running AI and eval operations from blocking unrelated requests where practical.
- Provide one command, endpoint, or documented process to run the supplied eval cases and produce an evaluation summary.
- Do not depend on any specific programming language, framework, or hosted AI provider for the core design.

## Suggested API Surface

You may design your own API shape, but a complete solution should cover flows similar to these:

- `POST /documents/ingest`
- `GET /documents/search?q=...`
- `GET /tickets`
- `GET /tickets/{ticketId}`
- `POST /tickets/{ticketId}/triage`
- `POST /tickets/{ticketId}/draft-reply`
- `POST /tool-actions`
- `POST /tool-actions/{actionId}/approve`
- `POST /tool-actions/{actionId}/execute`
- `GET /agent-runs/{runId}`
- `POST /eval-runs`
- `GET /eval-runs/{evalRunId}`

## Suggested Milestones

You may plan your own schedule, but this staging keeps scope manageable:

1. **Core platform:** Data loading, tickets, customers, orders, persistence, knowledge-base ingestion.
2. **Retrieval and triage:** Knowledge-base search, ticket triage with stored traces.
3. **Grounded drafts:** Draft replies with citations, refusal/escalation for unsupported requests, and draft storage.
4. **Tools and guardrails:** Tool registry, approval gates, idempotency, prompt-injection defenses.
5. **Frontend and evals:** Simple support-agent UI, eval runner over `data/eval_cases.jsonl`, evaluation report, documentation, demo video.

The Must Have section above defines the minimum viable submission.

For a more detailed build path and FAQ, see `docs/IMPLEMENTATION_GUIDE.md`.

## Provided Starter Dataset

This capstone pack includes:

- Fictional customers and orders.
- Support tickets with expected triage labels.
- Policy documents for refunds, shipping, warranty, account security, coupons, and support playbooks.
- Eval cases covering ordinary support tickets, unsupported requests, and adversarial prompt injection.
- A mock tool-action catalog.
- Raw files that can be loaded into any database or storage system.
- Optional Python scripts to seed a local SQLite database and run a retrieval baseline.

You may extend the dataset, but you must document any added data and how it affects evaluation.

## Assessment Criteria

- **Must Have workflow - 60%:** Does the system load the provided data, expose the required APIs, provide a simple frontend, triage tickets, generate cited drafts, handle one approval-gated action with idempotency, store minimal traces, and run evals?
- **AI quality and guardrails - 25%:** Are answers grounded in policy, cited correctly, escalated when uncertain, and safe on the adversarial eval cases?
- **Engineering quality, documentation, and demo - 15%:** Is the code maintainable, is setup clear, are design decisions documented, and does the demo clearly show the core workflow?
- Good To Have and Stretch work can strengthen the project, but it should not compensate for missing Must Have functionality.

## Deliverables

1. Final functional product with an API and simple frontend.
2. README with setup instructions, API documentation, architecture, and design decisions.
3. Public GitHub repository link.
4. Seeded demo data and instructions to reproduce the demo.
5. Evaluation report showing performance on the provided eval cases.
6. Explainer video demonstrating the project, including at least one adversarial or unsafe request being handled correctly.
