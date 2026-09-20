-- CreateTable
CREATE TABLE "customer" (
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "tags" TEXT[],

    CONSTRAINT "customer_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "order" (
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "placed_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    "eligible_return_until" TIMESTAMPTZ(3),
    "total" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "payment_status" TEXT NOT NULL,
    "tracking_number" TEXT NOT NULL,
    "items" JSONB NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "ticket" (
    "ticket_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "order_id" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateTable
CREATE TABLE "ticket_expectation" (
    "ticket_id" TEXT NOT NULL,
    "expected_category" TEXT NOT NULL,
    "expected_priority" TEXT NOT NULL,
    "expected_sentiment" TEXT NOT NULL,
    "expected_escalation" BOOLEAN NOT NULL,
    "expected_actions" TEXT[],

    CONSTRAINT "ticket_expectation_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateTable
CREATE TABLE "knowledge_document" (
    "doc_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "trust_level" TEXT NOT NULL,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "checksum" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "knowledge_document_pkey" PRIMARY KEY ("doc_id")
);

-- CreateTable
CREATE TABLE "knowledge_chunk" (
    "id" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "search_vector" tsvector,

    CONSTRAINT "knowledge_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_result" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "should_escalate" BOOLEAN NOT NULL,
    "reason_summary" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triage_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_reply" (
    "draft_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "citations" TEXT[],
    "recommended_actions" JSONB NOT NULL,
    "refusal_reason" TEXT,
    "run_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_reply_pkey" PRIMARY KEY ("draft_id")
);

-- CreateTable
CREATE TABLE "tool_definition" (
    "tool_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "requires_human_approval" BOOLEAN NOT NULL,
    "allowed_categories" TEXT[],
    "required_fields" TEXT[],
    "max_amount_inr" INTEGER,

    CONSTRAINT "tool_definition_pkey" PRIMARY KEY ("tool_name")
);

-- CreateTable
CREATE TABLE "tool_action_request" (
    "action_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "risk_level" TEXT NOT NULL,
    "requires_human_approval" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(3),

    CONSTRAINT "tool_action_request_pkey" PRIMARY KEY ("action_id")
);

-- CreateTable
CREATE TABLE "approval" (
    "approval_id" TEXT NOT NULL,
    "action_id" TEXT,
    "draft_id" TEXT,
    "reviewer_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("approval_id")
);

-- CreateTable
CREATE TABLE "agent_run" (
    "run_id" TEXT NOT NULL,
    "ticket_id" TEXT,
    "run_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "retrieved_doc_ids" TEXT[],
    "tool_calls" JSONB NOT NULL,
    "guardrail_results" JSONB NOT NULL,
    "model_provider" TEXT,
    "model_name" TEXT,
    "prompt_version" TEXT,
    "latency_ms" INTEGER,
    "token_usage" JSONB,
    "cost_estimate" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "eval_case" (
    "case_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "expected" JSONB NOT NULL,

    CONSTRAINT "eval_case_pkey" PRIMARY KEY ("case_id")
);

-- CreateTable
CREATE TABLE "eval_run" (
    "eval_run_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "total_cases" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "case_results" JSONB NOT NULL,

    CONSTRAINT "eval_run_pkey" PRIMARY KEY ("eval_run_id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "feedback_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "draft_id" TEXT,
    "rating" INTEGER NOT NULL,
    "reason" TEXT,
    "corrected_response" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("feedback_id")
);

-- CreateIndex
CREATE INDEX "order_customer_id_idx" ON "order"("customer_id");

-- CreateIndex
CREATE INDEX "ticket_customer_id_idx" ON "ticket"("customer_id");

-- CreateIndex
CREATE INDEX "ticket_order_id_idx" ON "ticket"("order_id");

-- CreateIndex
CREATE INDEX "knowledge_chunk_doc_id_idx" ON "knowledge_chunk"("doc_id");

-- CreateIndex
CREATE INDEX "triage_result_ticket_id_idx" ON "triage_result"("ticket_id");

-- CreateIndex
CREATE INDEX "draft_reply_ticket_id_idx" ON "draft_reply"("ticket_id");

-- CreateIndex
CREATE INDEX "tool_action_request_ticket_id_idx" ON "tool_action_request"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_action_request_tool_name_idempotency_key_key" ON "tool_action_request"("tool_name", "idempotency_key");

-- CreateIndex
CREATE INDEX "approval_action_id_idx" ON "approval"("action_id");

-- CreateIndex
CREATE INDEX "approval_draft_id_idx" ON "approval"("draft_id");

-- CreateIndex
CREATE INDEX "agent_run_ticket_id_idx" ON "agent_run"("ticket_id");

-- CreateIndex
CREATE INDEX "feedback_ticket_id_idx" ON "feedback"("ticket_id");

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_expectation" ADD CONSTRAINT "ticket_expectation_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "knowledge_document"("doc_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triage_result" ADD CONSTRAINT "triage_result_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_reply" ADD CONSTRAINT "draft_reply_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_action_request" ADD CONSTRAINT "tool_action_request_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_action_request" ADD CONSTRAINT "tool_action_request_tool_name_fkey" FOREIGN KEY ("tool_name") REFERENCES "tool_definition"("tool_name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "tool_action_request"("action_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "draft_reply"("draft_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "ticket"("ticket_id") ON DELETE SET NULL ON UPDATE CASCADE;
