#!/usr/bin/env python3
import argparse
import json
import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do",
    "for", "from", "has", "have", "i", "if", "in", "is", "it", "me",
    "my", "no", "not", "of", "on", "or", "our", "please", "the", "this",
    "to", "was", "with", "you", "your"
}


def tokens(text):
    return {
        token
        for token in re.findall(r"[a-z0-9_]+", text.lower())
        if token not in STOPWORDS and len(token) > 2
    }


def score(query_tokens, doc_text):
    doc_tokens = tokens(doc_text)
    return len(query_tokens & doc_tokens)


def load_docs(conn):
    return conn.execute(
        "SELECT doc_id, title, content FROM knowledge_documents"
    ).fetchall()


def load_eval_cases(conn):
    return conn.execute(
        """
        SELECT e.case_id, e.ticket_id, e.input, e.expected_json, t.subject, t.body
        FROM eval_cases e
        JOIN tickets t ON t.ticket_id = e.ticket_id
        ORDER BY e.case_id
        """
    ).fetchall()


def main():
    parser = argparse.ArgumentParser(description="Run a simple TrustDesk retrieval baseline.")
    parser.add_argument("--db", default=str(ROOT / "trustdesk_seed.db"), help="SQLite database path.")
    parser.add_argument("--top-k", type=int, default=3, help="Number of documents to retrieve.")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        docs = load_docs(conn)
        cases = load_eval_cases(conn)
    finally:
        conn.close()

    total = 0
    passed = 0
    for case_id, ticket_id, case_input, expected_json, subject, body in cases:
        expected = json.loads(expected_json)
        must_cite = set(expected.get("must_cite_doc_ids", []))
        query = f"{case_input} {subject} {body}"
        query_tokens = tokens(query)
        ranked = sorted(
            (
                (score(query_tokens, f"{doc_id} {title} {content}"), doc_id, title)
                for doc_id, title, content in docs
            ),
            reverse=True,
        )
        top_docs = [doc_id for value, doc_id, title in ranked[: args.top_k] if value > 0]
        hit = must_cite.issubset(set(top_docs))
        total += 1
        passed += int(hit)
        status = "PASS" if hit else "MISS"
        print(f"{status} {case_id} ticket={ticket_id} expected={sorted(must_cite)} top={top_docs}")

    print(f"\nCitation baseline: {passed}/{total} cases include all required docs in top {args.top_k}.")


if __name__ == "__main__":
    main()

