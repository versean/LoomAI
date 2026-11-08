"""Plain-text rendering shared by terminal commands and MCP tool results."""

from __future__ import annotations


def status(me: dict, server_url: str) -> str:
    lines = [
        f"Connected to Loom AI at {server_url}",
        f"You: {me['user']} <{me['email']}>{' (admin)' if me['is_admin'] else ''}",
        f"Team: {me['team']} · this device: {me['device']} · scopes: {', '.join(me['scopes'])}",
        f"Inbox: {me['inbox_waiting']} new item(s)",
        "Projects:",
    ]
    lines += [
        f"  - {p['slug']} ({p['name']}): {p['role']}, {p['members']} member(s), {p['documents']} file(s)"
        for p in me["projects"]
    ] or ["  (none yet)"]
    providers = me.get("providers", {})
    if providers:
        lines.append(
            f"Models: embeddings={providers['embedder']}, reranker={providers['reranker']}, llm={providers['llm']}"
        )
    return "\n".join(lines)


def answer(result: dict) -> str:
    text = result["answer"]
    if result.get("citations"):
        sources = "\n".join(
            f"[{c['n']}] {c['project']}:{c['path']} lines {c['lines']}"
            + (f" ({c['section']})" if c.get("section") else "")
            for c in result["citations"]
        )
        text += f"\n\nSources:\n{sources}"
    if result.get("standalone_query") and result["standalone_query"] != result.get("question"):
        text += f"\n\n(searched for: {result['standalone_query']})"
    return text + "\n— Loom AI"


def hits(result: dict) -> str:
    if not result["hits"]:
        return "No matching project knowledge."
    header = (
        "Grounded results"
        if result["grounded"]
        else (f"Weak matches only (top score {result['top_score']:.2f} < threshold {result['threshold']:.2f})")
    )
    blocks = [header + ":"]
    for i, hit in enumerate(result["hits"], start=1):
        section = f" ({hit['heading']})" if hit.get("heading") else ""
        snippet = hit["content"] if len(hit["content"]) <= 700 else hit["content"][:700] + "\n…"
        blocks.append(f"[{i}] {hit['location']}{section} score={hit['score']:.2f}\n{snippet}")
    return "\n\n".join(blocks)


def inbox(items: list[dict]) -> str:
    if not items:
        return "Inbox is empty."
    return "\n".join(
        f"- {item['id']} · {item['kind']} '{item['filename']}' from {item['from']} "
        f"(project {item['project']}, {item['status']})" + (f": {item['note']}" if item["note"] else "")
        for item in items
    )
