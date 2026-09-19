# TrustDesk Capstone Pack

This repository contains a self-contained capstone package for building **TrustDesk**, an AI-first customer support operations product.

The capstone is language agnostic. You may implement it in Node.js, Java, Python, Go, Ruby, or any stack you are comfortable with, as long as you satisfy the product, API, data, security, and evaluation requirements.

## Contents

- `TRUSTDESK_PROBLEM_STATEMENT.md` - capstone problem statement.
- `docs/IMPLEMENTATION_GUIDE.md` - suggested build order, demo scenarios, and FAQ.
- `docs/API_CONTRACT.md` - language-agnostic API contract and expected flows.
- `docs/DATA_MODEL.md` - suggested entities, relationships, and storage expectations.
- `docs/EVALUATION_GUIDE.md` - how to use the eval cases and what to measure.
- `data/knowledge_base/` - sample policy and support documents for retrieval.
- `data/customers.json` - fictional customer records.
- `data/orders.json` - fictional order records.
- `data/tickets.json` - support tickets with expected triage labels.
- `data/eval_cases.jsonl` - evaluation cases for answer quality, citations, routing, and guardrails.
- `data/tool_actions.json` - mock tool/action catalog for agentic workflows.
- `scripts/seed_trustdesk.py` - optional Python utility that creates a local SQLite database from the sample data.
- `scripts/run_baseline_retrieval.py` - optional Python utility that runs a simple keyword baseline over the seeded knowledge base.
- `scripts/validate_pack.py` - optional Python utility that validates that the package data is parseable and internally consistent.

## Optional Local Utilities

From this folder:

```bash
python3 scripts/validate_pack.py
python3 scripts/seed_trustdesk.py --db trustdesk_seed.db
python3 scripts/run_baseline_retrieval.py --db trustdesk_seed.db
```

The scripts use only Python standard library modules.

You do not need to use these scripts or SQLite for your project. You can load the raw files in `data/` into PostgreSQL, MySQL, MongoDB, Elasticsearch, Redis, a vector database, local files, or any other storage system you choose.

## Language-Agnostic Expectations

Your implementation should provide:

- An HTTP API matching the core flows in `docs/API_CONTRACT.md`.
- A lightweight frontend/demo UI for support workflows.
- A persistent data model covering the entities in `docs/DATA_MODEL.md`.
- A retrieval layer over `data/knowledge_base/`.
- An AI/model adapter that can be mocked in tests.
- Guardrails for prompt injection, sensitive data leakage, unsafe tool use, and unsupported answers.
- An evaluation command, endpoint, or script that runs `data/eval_cases.jsonl` and reports results.

The frontend can be vibe-coded or AI-assisted. It does not need to be visually complex, but it should let you demonstrate ticket triage, grounded draft replies, citations, approval-gated tool actions, and evaluation results.

## Recommended Reading Order

1. Read `TRUSTDESK_PROBLEM_STATEMENT.md`.
2. Follow `docs/IMPLEMENTATION_GUIDE.md` for the build path.
3. Use `docs/API_CONTRACT.md` and `docs/DATA_MODEL.md` while designing your implementation.
4. Use `docs/EVALUATION_GUIDE.md` before writing the eval runner.

## Security Notes

The dataset intentionally includes adversarial tickets and one adversarial knowledge-base document. Do not treat retrieved text or customer text as trusted instructions. Your project should include prompt-injection defenses, citation checks, tool permissioning, human approval gates, and evaluation reports.
