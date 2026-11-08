"""Local MCP server that Cursor and Claude Code launch; every tool call goes to the gateway.

Running locally (instead of agents calling the gateway directly) lets this computer's token,
the agent's identity and a local secret check sit in front of every request.
"""

from __future__ import annotations

import contextlib
import logging
import os
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlparse
from uuid import uuid4

import anyio
from mcp.server.mcpserver import Context, MCPServer
from mcp.shared.exceptions import MCPDeprecationWarning

from loom_common.secrets import is_sensitive_path, scan_text

from . import render
from .client import LoomClient, LoomError
from .config import load_config
from .installer import install

SESSION_KEY = uuid4().hex

INSTRUCTIONS = """Loom AI is the shared brain of the user's team. Its Conductor AI answers questions with cited sources.
It holds every project's code, docs, skills and notes, and delivers files between teammates.
- For questions about the team's projects, files, decisions or teammates, call ask_project
  (or search_project for raw passages) and cite the sources it returns.
- When the user wants to share a file, skill or message with a teammate, call send_to_teammate.
- At the start of a conversation, call check_inbox and mention any new items.
- When the user asks to remember or save something for the team, call save_note."""

mcp = MCPServer(name="Loom AI", instructions=INSTRUCTIONS)


def _client_name(ctx: Context) -> str:
    try:
        info = ctx.session.client_params.client_info
        return info.name if info and info.name else "mcp-client"
    except (AttributeError, ValueError):
        return "mcp-client"


def _client(ctx: Context) -> LoomClient:
    return LoomClient(load_config(), client_name=_client_name(ctx))


async def _workspace_root(ctx: Context) -> Path:
    configured = os.environ.get("LOOM_WORKSPACE", "")
    if configured and "${" not in configured:
        return Path(configured).expanduser()
    try:
        with anyio.fail_after(2), warnings.catch_warnings():
            warnings.simplefilter("ignore", MCPDeprecationWarning)
            roots = (await ctx.session.list_roots()).roots
        for root in roots:
            uri = urlparse(str(root.uri))
            if uri.scheme == "file":
                return Path(unquote(uri.path))
    except Exception:  # client without roots support
        pass
    return Path.cwd()


async def _api[T](call: Callable[[], T]) -> T:
    """Run a blocking gateway call off the event loop."""
    return await anyio.to_thread.run_sync(call)


def _failure(error: LoomError) -> str:
    prefix = "Loom AI refused" if error.denied else "Loom AI error"
    return f"{prefix}: {error.reason}"


@mcp.tool()
async def whoami(ctx: Context) -> str:
    """Show whether this agent is connected to Loom AI, as whom, and which projects it can see."""
    client = _client(ctx)
    try:
        return render.status(await _api(lambda: client.get("/api/me")), client.config.server_url)
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def ask_project(question: str, ctx: Context, project: str | None = None, path_prefix: str | None = None) -> str:
    """Ask the Conductor, Loom AI's central AI, about the team's projects and get a cited answer.

    Answers come only from indexed project knowledge (code, docs, skills, notes); when nothing
    relevant exists it says "Not in project knowledge." instead of guessing.
    project: project slug; omit to search every project the user belongs to.
    path_prefix: optional folder to restrict the search, e.g. "src/auth".
    """
    client = _client(ctx)
    try:
        result = await _api(
            lambda: client.post(
                "/api/ask",
                {
                    "query": question,
                    "project": project,
                    "path_prefix": path_prefix,
                    "session_key": SESSION_KEY,
                },
            )
        )
        return render.answer(result | {"question": question})
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def search_project(query: str, ctx: Context, project: str | None = None, path_prefix: str | None = None) -> str:
    """Return the most relevant raw passages (with file paths and line numbers) for a query."""
    client = _client(ctx)
    try:
        return render.hits(
            await _api(
                lambda: client.post("/api/search", {"query": query, "project": project, "path_prefix": path_prefix})
            )
        )
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def project_brief(ctx: Context, project: str | None = None) -> str:
    """Get the onboarding brief of a project: overview, team, structure, key files and skills."""
    client = _client(ctx)
    try:
        slug = await _api(lambda: client.resolve_project(project))
        return (await _api(lambda: client.get(f"/api/projects/{slug}/brief")))["brief"]
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def get_project_file(path: str, ctx: Context, project: str | None = None) -> str:
    """Read the full content of one file stored in a project's knowledge."""
    client = _client(ctx)
    try:
        slug = await _api(lambda: client.resolve_project(project))
        return (await _api(lambda: client.get(f"/api/projects/{slug}/file", path=path)))["content"]
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def send_to_teammate(
    to: str,
    ctx: Context,
    project: str | None = None,
    path: str | None = None,
    content: str | None = None,
    filename: str | None = None,
    kind: Literal["file", "skill", "message"] = "file",
    note: str = "",
) -> str:
    """Send a file, an agent skill or a short message to a teammate's inbox.

    to: teammate's name or email.
    path: a local file to send (relative to the open workspace); or pass content + filename.
    kind: "skill" installs into the teammate's agent skills folders, "file" into their inbox
    folder, "message" is text only.
    Credentials and files containing secrets are blocked before they leave this computer.
    """
    client = _client(ctx)
    if path:
        file_path = Path(path).expanduser()
        if not file_path.is_absolute():
            file_path = await _workspace_root(ctx) / file_path
        if not file_path.is_file():
            return f"File not found: {file_path}"
        content = file_path.read_text(errors="replace")
        filename = filename or (
            str(Path(file_path.parent.name) / file_path.name) if kind == "skill" else file_path.name
        )
    if content is None:
        return "Provide either path or content."
    filename = filename or ("message.txt" if kind == "message" else "shared.txt")

    findings = scan_text(content) + scan_text(note)
    if is_sensitive_path(filename) or findings:
        reason = "credential file" if is_sensitive_path(filename) else "; ".join(f.describe() for f in findings[:3])
        with contextlib.suppress(LoomError):
            await _api(
                lambda: client.post(
                    "/api/agent-events",
                    {
                        "event": "share_blocked",
                        "decision": "deny",
                        "reason": reason,
                        "detail": {"to": to, "filename": filename, "where": "local"},
                    },
                )
            )
        return f"Blocked on this computer, nothing was sent: {reason}"

    try:
        result = await _api(
            lambda: client.post(
                "/api/send",
                {
                    "project": client.resolve_project(project),
                    "to": to,
                    "filename": filename,
                    "content": content,
                    "kind": kind,
                    "note": note,
                },
            )
        )
        item = result["delivery"]
        return (
            f"Sent {item['kind']} '{item['filename']}' to {result['recipient']}'s inbox "
            f"(project {item['project']}). They are notified and can accept it."
        )
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def check_inbox(ctx: Context) -> str:
    """List files, skills and messages teammates have sent to the user that are not yet handled."""
    client = _client(ctx)
    try:
        return render.inbox(await _api(lambda: client.get("/api/inbox")))
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def accept_delivery(
    delivery_id: str, ctx: Context, destination: Literal["default", "workspace"] = "default"
) -> str:
    """Accept an inbox item and install it on this computer.

    destination: "default" puts skills into the agent skills folders and files into the Loom
    inbox folder; "workspace" puts files into the currently open project.
    """
    client = _client(ctx)
    try:
        item = await _api(lambda: client.post(f"/api/inbox/{delivery_id}/accept"))
    except LoomError as error:
        return _failure(error)
    project_dir = await _workspace_root(ctx) if destination == "workspace" else None
    written = install(item, item["content"], client.config, project_dir)
    if item["kind"] == "message":
        return f"Message from {item['from']}:\n{item['content']}"
    where = "\n".join(f"- {p}" for p in written)
    return f"Installed {item['kind']} '{item['filename']}' from {item['from']}:\n{where}"


@mcp.tool()
async def decline_delivery(delivery_id: str, ctx: Context) -> str:
    """Decline an inbox item; the sender is told it was declined."""
    client = _client(ctx)
    try:
        item = await _api(lambda: client.post(f"/api/inbox/{delivery_id}/decline"))
        return f"Declined '{item['filename']}' from {item['from']}."
    except LoomError as error:
        return _failure(error)


@mcp.tool()
async def save_note(title: str, content: str, ctx: Context, project: str | None = None) -> str:
    """Save a decision, explanation or summary to the project so teammates' agents can find it."""
    client = _client(ctx)
    try:
        slug = await _api(lambda: client.resolve_project(project))
        result = await _api(lambda: client.post(f"/api/projects/{slug}/notes", {"title": title, "content": content}))
        return f"Saved to {slug} knowledge as {result['path']}; every project member can now find it."
    except LoomError as error:
        return _failure(error)


def run() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    mcp.run("stdio")
