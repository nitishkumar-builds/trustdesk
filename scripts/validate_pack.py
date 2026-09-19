#!/usr/bin/env python3
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
KB_DIR = DATA_DIR / "knowledge_base"


def read_json(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path):
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise ValueError(f"{path}:{line_number}: invalid JSONL: {exc}") from exc
    return rows


def doc_id_from_text(path, text):
    for line in text.splitlines():
        if line.lower().startswith("doc id:"):
            return line.split(":", 1)[1].strip()
    raise ValueError(f"{path} is missing 'Doc ID:'")


def main():
    customers = read_json(DATA_DIR / "customers.json")
    orders = read_json(DATA_DIR / "orders.json")
    tickets = read_json(DATA_DIR / "tickets.json")
    tools = read_json(DATA_DIR / "tool_actions.json")
    eval_cases = read_jsonl(DATA_DIR / "eval_cases.jsonl")

    customer_ids = {row["customer_id"] for row in customers}
    order_ids = {row["order_id"] for row in orders}
    ticket_ids = {row["ticket_id"] for row in tickets}
    tool_names = {row["tool_name"] for row in tools}
    doc_ids = set()

    for path in KB_DIR.glob("*.md"):
        text = path.read_text(encoding="utf-8")
        doc_id = doc_id_from_text(path, text)
        if doc_id in doc_ids:
            raise ValueError(f"Duplicate doc id: {doc_id}")
        doc_ids.add(doc_id)

    for order in orders:
        if order["customer_id"] not in customer_ids:
            raise ValueError(f"Order {order['order_id']} has unknown customer_id {order['customer_id']}")

    for ticket in tickets:
        if ticket["customer_id"] not in customer_ids:
            raise ValueError(f"Ticket {ticket['ticket_id']} has unknown customer_id {ticket['customer_id']}")
        if ticket.get("order_id") and ticket["order_id"] not in order_ids:
            raise ValueError(f"Ticket {ticket['ticket_id']} has unknown order_id {ticket['order_id']}")
        for action in ticket.get("expected_actions", []):
            if action not in tool_names:
                raise ValueError(f"Ticket {ticket['ticket_id']} references unknown action {action}")

    for case in eval_cases:
        expected = case["expected"]
        if case["ticket_id"] not in ticket_ids:
            raise ValueError(f"Eval case {case['case_id']} has unknown ticket_id {case['ticket_id']}")
        missing_docs = set(expected.get("must_cite_doc_ids", [])) - doc_ids
        if missing_docs:
            raise ValueError(f"Eval case {case['case_id']} references unknown doc ids {sorted(missing_docs)}")
        for action in expected.get("allowed_actions", []) + expected.get("disallowed_actions", []):
            if action not in tool_names:
                raise ValueError(f"Eval case {case['case_id']} references unknown action {action}")

    print("TrustDesk capstone pack is valid.")
    print(f"Customers: {len(customers)}")
    print(f"Orders: {len(orders)}")
    print(f"Tickets: {len(tickets)}")
    print(f"Knowledge documents: {len(doc_ids)}")
    print(f"Eval cases: {len(eval_cases)}")
    print(f"Tool actions: {len(tools)}")


if __name__ == "__main__":
    main()

