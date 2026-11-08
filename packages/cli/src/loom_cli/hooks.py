"""Cursor hook handlers: a prompt guard that runs on the laptop and an activity reporter.

Both read Cursor's JSON event on stdin. The prompt guard blocks a prompt that contains a
credential before it reaches any model; the reporter never blocks the agent (fails open).
"""

from __future__ import annotations

import contextlib
import json
import re
import sys

from loom_common.secrets import scan_text

from .client import LoomClient, LoomError
from .config import load_config

OWN_TOOLS = frozenset(
    {
        "whoami",
        "ask_project",
        "search_project",
        "project_brief",
        "get_project_file",
        "send_to_teammate",
        "check_inbox",
        "accept_delivery",
        "decline_delivery",
        "save_note",
    }
)


def _read_event() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return {}


def _report(event: str, decision: str, reason: str | None, detail: dict) -> None:
    config = load_config()
    if not config.token:
        return
    with contextlib.suppress(LoomError):
        LoomClient(config, client_name="cursor-hook", timeout=3).post(
            "/api/agent-events",
            {"event": event, "decision": decision, "reason": reason, "detail": detail},
        )


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower().replace("m_c_p", "mcp")


def prompt_check() -> int:
    event = _read_event()
    findings = scan_text(event.get("prompt", ""))
    if not findings:
        print(json.dumps({"continue": True}))
        return 0
    reason = "; ".join(f.describe() for f in findings[:3])
    message = f"Loom AI blocked this prompt because it contains a secret ({reason}). Remove it and retry."
    _report(
        "prompt_blocked",
        "deny",
        reason,
        {"conversation": event.get("conversation_id"), "roots": event.get("workspace_roots")},
    )
    print(json.dumps({"continue": False, "user_message": message}))
    return 0  # Cursor only reads the JSON verdict when the hook exits 0


def audit() -> int:
    try:
        event = _read_event()
        name = event.get("hook_event_name")
        if not name:
            print("{}")
            return 0
        tool = event.get("tool_name") or ""
        server = event.get("mcp_server_name") or ""
        own_call = "loom" in server.lower() or (not server and any(tool.endswith(t) for t in OWN_TOOLS))
        if not own_call:  # Loom's own calls are audited server-side
            keys = ("mcp_server_name", "tool_name", "duration", "status", "loop_count")
            detail = {k: event[k] for k in keys if k in event}
            detail["conversation"] = event.get("conversation_id")
            _report(f"cursor.{_snake(name)}"[:40], "allow", None, detail)
    except Exception:  # never break the user's agent
        pass
    print("{}")
    return 0
