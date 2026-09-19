#!/usr/bin/env python3
import argparse
import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
KB_DIR = DATA_DIR / "knowledge_base"


def load_json(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_jsonl(path):
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def doc_id_from_markdown(text):
    for line in text.splitlines():
        if line.lower().startswith("doc id:"):
            return line.split(":", 1)[1].strip()
    raise ValueError("Knowledge document is missing 'Doc ID:'")


def title_from_markdown(text, fallback):
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return fallback


def reset_schema(conn):
    conn.executescript(
        """
        DROP TABLE IF EXISTS feedback;
        DROP TABLE IF EXISTS agent_runs;
        DROP TABLE IF EXISTS tool_action_catalog;
        DROP TABLE IF EXISTS eval_cases;
        DROP TABLE IF EXISTS knowledge_documents;
        DROP TABLE IF EXISTS tickets;
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS customers;

        CREATE TABLE customers (
            customer_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            tier TEXT NOT NULL,
            country TEXT NOT NULL,
            created_at TEXT NOT NULL,
            verified INTEGER NOT NULL,
            tags_json TEXT NOT NULL
        );

        CREATE TABLE orders (
            order_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL REFERENCES customers(customer_id),
            status TEXT NOT NULL,
            placed_at TEXT NOT NULL,
            delivered_at TEXT,
            eligible_return_until TEXT,
            total INTEGER NOT NULL,
            currency TEXT NOT NULL,
            payment_status TEXT NOT NULL,
            tracking_number TEXT,
            items_json TEXT NOT NULL
        );

        CREATE TABLE tickets (
            ticket_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL REFERENCES customers(customer_id),
            order_id TEXT REFERENCES orders(order_id),
            channel TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            expected_category TEXT,
            expected_priority TEXT,
            expected_sentiment TEXT,
            expected_escalation INTEGER,
            expected_actions_json TEXT NOT NULL
        );

        CREATE TABLE knowledge_documents (
            doc_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_path TEXT NOT NULL,
            content TEXT NOT NULL
        );

        CREATE TABLE eval_cases (
            case_id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(ticket_id),
            input TEXT NOT NULL,
            expected_json TEXT NOT NULL
        );

        CREATE TABLE tool_action_catalog (
            tool_name TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            risk_level TEXT NOT NULL,
            requires_human_approval INTEGER NOT NULL,
            allowed_categories_json TEXT NOT NULL,
            required_fields_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL
        );

        CREATE TABLE agent_runs (
            run_id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(ticket_id),
            run_type TEXT NOT NULL,
            status TEXT NOT NULL,
            retrieved_doc_ids_json TEXT NOT NULL DEFAULT '[]',
            tool_calls_json TEXT NOT NULL DEFAULT '[]',
            guardrail_results_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE feedback (
            feedback_id TEXT PRIMARY KEY,
            ticket_id TEXT REFERENCES tickets(ticket_id),
            rating INTEGER NOT NULL,
            reason TEXT,
            corrected_response TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )

    try:
        conn.executescript(
            """
            DROP TABLE IF EXISTS knowledge_documents_fts;
            CREATE VIRTUAL TABLE knowledge_documents_fts
            USING fts5(doc_id UNINDEXED, title, content);
            """
        )
    except sqlite3.OperationalError:
        # Some Python builds omit FTS5. The baseline retrieval script can still
        # read from knowledge_documents directly.
        pass


def seed_customers(conn):
    rows = load_json(DATA_DIR / "customers.json")
    for row in rows:
        conn.execute(
            """
            INSERT INTO customers
            (customer_id, name, email, tier, country, created_at, verified, tags_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["customer_id"],
                row["name"],
                row["email"],
                row["tier"],
                row["country"],
                row["created_at"],
                int(row["verified"]),
                json.dumps(row["tags"]),
            ),
        )


def seed_orders(conn):
    rows = load_json(DATA_DIR / "orders.json")
    for row in rows:
        conn.execute(
            """
            INSERT INTO orders
            (order_id, customer_id, status, placed_at, delivered_at, eligible_return_until,
             total, currency, payment_status, tracking_number, items_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["order_id"],
                row["customer_id"],
                row["status"],
                row["placed_at"],
                row.get("delivered_at"),
                row.get("eligible_return_until"),
                row["total"],
                row["currency"],
                row["payment_status"],
                row.get("tracking_number"),
                json.dumps(row["items"]),
            ),
        )


def seed_tickets(conn):
    rows = load_json(DATA_DIR / "tickets.json")
    for row in rows:
        conn.execute(
            """
            INSERT INTO tickets
            (ticket_id, customer_id, order_id, channel, subject, body, created_at, status,
             expected_category, expected_priority, expected_sentiment, expected_escalation,
             expected_actions_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["ticket_id"],
                row["customer_id"],
                row.get("order_id"),
                row["channel"],
                row["subject"],
                row["body"],
                row["created_at"],
                row["status"],
                row.get("expected_category"),
                row.get("expected_priority"),
                row.get("expected_sentiment"),
                int(row.get("expected_escalation", False)),
                json.dumps(row.get("expected_actions", [])),
            ),
        )


def seed_knowledge_documents(conn):
    for path in sorted(KB_DIR.glob("*.md")):
        content = path.read_text(encoding="utf-8")
        doc_id = doc_id_from_markdown(content)
        title = title_from_markdown(content, path.stem)
        conn.execute(
            """
            INSERT INTO knowledge_documents (doc_id, title, source_path, content)
            VALUES (?, ?, ?, ?)
            """,
            (doc_id, title, str(path.relative_to(ROOT)), content),
        )
        try:
            conn.execute(
                """
                INSERT INTO knowledge_documents_fts (doc_id, title, content)
                VALUES (?, ?, ?)
                """,
                (doc_id, title, content),
            )
        except sqlite3.OperationalError:
            pass


def seed_eval_cases(conn):
    rows = load_jsonl(DATA_DIR / "eval_cases.jsonl")
    for row in rows:
        conn.execute(
            """
            INSERT INTO eval_cases (case_id, ticket_id, input, expected_json)
            VALUES (?, ?, ?, ?)
            """,
            (
                row["case_id"],
                row["ticket_id"],
                row["input"],
                json.dumps(row["expected"]),
            ),
        )


def seed_tool_actions(conn):
    rows = load_json(DATA_DIR / "tool_actions.json")
    for row in rows:
        metadata = {
            k: v
            for k, v in row.items()
            if k
            not in {
                "tool_name",
                "description",
                "risk_level",
                "requires_human_approval",
                "allowed_categories",
                "required_fields",
            }
        }
        conn.execute(
            """
            INSERT INTO tool_action_catalog
            (tool_name, description, risk_level, requires_human_approval,
             allowed_categories_json, required_fields_json, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["tool_name"],
                row["description"],
                row["risk_level"],
                int(row["requires_human_approval"]),
                json.dumps(row["allowed_categories"]),
                json.dumps(row["required_fields"]),
                json.dumps(metadata),
            ),
        )


def main():
    parser = argparse.ArgumentParser(description="Seed the TrustDesk SQLite database.")
    parser.add_argument("--db", default=str(ROOT / "trustdesk_seed.db"), help="Output SQLite database path.")
    args = parser.parse_args()

    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    try:
        reset_schema(conn)
        seed_customers(conn)
        seed_orders(conn)
        seed_tickets(conn)
        seed_knowledge_documents(conn)
        seed_eval_cases(conn)
        seed_tool_actions(conn)
        conn.commit()
    finally:
        conn.close()

    print(f"Seeded TrustDesk database: {db_path}")


if __name__ == "__main__":
    main()

