"""``loom``: the team member's side of Loom AI."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import platform
import subprocess
import webbrowser
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

import typer

from loom_common.ignore import skip_reason
from loom_common.secrets import is_sensitive_path, scan_text

from . import connect as connectors
from . import render
from .client import LoomClient, LoomError
from .config import HOSTED_SERVER, Config, config_path, load_config, save_config
from .installer import install

app = typer.Typer(help="Loom AI: your team's shared project brain.", no_args_is_help=True)
project_app = typer.Typer(help="Create projects and manage who is in them.", no_args_is_help=True)
hook_app = typer.Typer(help="Handlers called by Cursor hooks (not for direct use).")
app.add_typer(project_app, name="project")
app.add_typer(hook_app, name="hook")

ProjectOpt = Annotated[str | None, typer.Option("--project", "-p", help="Project slug")]
BATCH_FILES = 150
BATCH_BYTES = 3_000_000
INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/versean/LoomAI/main/install.sh"


def _client(config: Config | None = None, timeout: float = 120) -> LoomClient:
    config = config or load_config()
    if not config.token:
        _fail("Not connected yet. Run `loom init` (first person) or `loom join <code>`.")
    return LoomClient(config, client_name="loom-cli", timeout=timeout)


def _fail(message: str) -> None:
    typer.secho(message, fg="red", err=True)
    raise typer.Exit(1)


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except LoomError as error:
        _fail(("Denied: " if error.denied else "Error: ") + error.reason)


def _device_name() -> str:
    return f"{os.environ.get('USER', 'me')}'s {platform.node().split('.')[0] or 'computer'}"


# ── Joining the team ────────────────────────────────────────────────────────


@app.command()
def init(
    team: Annotated[str, typer.Option(prompt="Team (team) name")],
    name: Annotated[str, typer.Option(prompt="Your name")],
    email: Annotated[str, typer.Option(prompt="Your email")],
    server: Annotated[str, typer.Option(help="Loom AI URL (default: the hosted Loom AI)")] = HOSTED_SERVER,
    device: Annotated[str | None, typer.Option(help="Name for this computer")] = None,
    secret: Annotated[str | None, typer.Option(help="Bootstrap secret, for self-hosted servers")] = None,
) -> None:
    """Start a new team (your team) and become its admin."""
    config = load_config()
    config.server_url = server.rstrip("/")
    result = _call(
        LoomClient(config).post,
        "/api/bootstrap",
        {
            "team_name": team,
            "email": email,
            "display_name": name,
            "device_name": device or _device_name(),
            "secret": secret,
        },
    )
    config.token, config.user, config.team = result["token"], result["user"], result["team"]
    save_config(config)
    typer.secho(f"Welcome, {name}! You are the admin of the '{team}' team.", fg="green")
    typer.echo("Next: `loom project create <name>`, `loom ingest .`, then `loom invite -p <project>`.")


@app.command()
def join(
    code: str,
    server: Annotated[str, typer.Option(help="Loom AI URL (default: the hosted Loom AI)")] = HOSTED_SERVER,
    device: Annotated[str | None, typer.Option(help="Name for this computer")] = None,
    name: Annotated[str | None, typer.Option(envvar="LOOM_NAME", help="Your name (team links ask for it)")] = None,
    email: Annotated[str | None, typer.Option(envvar="LOOM_EMAIL", help="Your email (team links ask)")] = None,
) -> None:
    """Join a team with the invite code or team link an admin gave you."""
    config = load_config()
    config.server_url = server.rstrip("/")
    client = LoomClient(config)
    body = {"code": code, "device_name": device or _device_name(), "display_name": name, "email": email}
    try:
        result = client.post("/api/join", body)
    except LoomError as error:
        if "needs your name and email" not in error.reason:
            _fail(("Denied: " if error.denied else "Error: ") + error.reason)
        typer.echo("This is a team link, so tell the team who you are.")
        body["display_name"] = name or typer.prompt("Your name")
        body["email"] = email or typer.prompt("Your email")
        result = _call(client.post, "/api/join", body)
    config.token, config.user, config.team = result["token"], result["user"], result["team"]
    save_config(config)
    typer.secho(f"Welcome to the '{result['team']}' team, {result['user']}!", fg="green")
    typer.echo("Next: `loom connect all`, then ask your agent: “Loom, who am I?”")


@app.command()
def status() -> None:
    """Show who you are, your projects, your inbox and which agents are connected."""
    config = load_config()
    client = _client(config)
    typer.echo(render.status(_call(client.get, "/api/me"), config.server_url))
    for scope, folder in (("global", Path.home()), ("this folder", Path.cwd())):
        cursor_mcp = folder / ".cursor" / "mcp.json"
        connected = cursor_mcp.exists() and '"loom"' in cursor_mcp.read_text()
        typer.echo(f"Cursor ({scope}): {'connected' if connected else 'not connected'}")
    typer.echo(f"Config: {config_path()}")


@app.command()
def logout() -> None:
    """Forget this computer's token."""
    config = load_config()
    config.token = None
    save_config(config)
    typer.echo("Logged out on this computer.")


@app.command()
def invite(
    email: Annotated[str | None, typer.Argument(help="Leave out to get one team link for a group chat")] = None,
    name: Annotated[str | None, typer.Option("--name", "-n", help="Their display name")] = None,
    project: ProjectOpt = None,
    role: Annotated[str, typer.Option(help="owner, member or viewer")] = "member",
    uses: Annotated[int, typer.Option(help="How many people a team link lets in")] = 20,
) -> None:
    """Invite people: `loom invite -p my-app` gives one team link; `loom invite sri@x.com -n Sri` a personal one."""
    if email and not name:
        name = email.split("@")[0].replace(".", " ").title()
    result = _call(
        _client().post,
        "/api/invites",
        {"email": email, "display_name": name, "project": project, "role": role, "max_uses": uses},
    )
    server = load_config().server_url
    days = result["expires_in_days"]
    target = f"the '{project}' project" if project else "your team"
    if email:
        typer.secho(f"Invite for {name} (valid {days} days). Send them this line privately:", fg="green")
    else:
        typer.secho(
            f"Team link to {target}: up to {result['max_uses']} people, valid {days} days. "
            "Paste it in your team chat; each person types their own name and email when they run it:",
            fg="green",
        )
    where = "" if server == HOSTED_SERVER else f" {server}"
    typer.echo(f"  curl -fsSL {INSTALL_SCRIPT_URL} | sh -s -- {result['code']}{where}")
    typer.echo("If they already have the `loom` command:")
    typer.echo(f"  loom join {result['code']}{' --server' + where if where else ''} && loom connect all")
    if urlparse(server).hostname in ("127.0.0.1", "localhost", "0.0.0.0", "::1"):
        typer.secho(
            f"Warning: you are connected to a Loom AI server on this computer ({server}), so nobody else can use "
            "this invite. To move to the hosted Loom AI, run `loom logout`, then the install line from the README.",
            fg="yellow",
        )
    if not email:
        typer.echo(f"Stop it working early: loom cancel-invite {result['code']}")


@app.command("cancel-invite")
def cancel_invite(code: str) -> None:
    """Stop an invite or team link from working; people who already joined stay."""
    result = _call(_client().post, "/api/invites/cancel", {"code": code})
    typer.echo(f"Cancelled. {result['used_by']} people had joined with it.")


# ── Projects ──────────────────────────────────────────────────────────────────


@project_app.command("create")
def project_create(
    name: str,
    slug: Annotated[str | None, typer.Option()] = None,
    description: Annotated[str, typer.Option()] = "",
) -> None:
    """Create a project; you become its owner."""
    result = _call(_client().post, "/api/projects", {"name": name, "slug": slug, "description": description})
    config = load_config()
    if not config.default_project:
        config.default_project = result["slug"]
        save_config(config)
    typer.secho(f"Created project '{result['slug']}'.", fg="green")


@project_app.command("list")
def project_list() -> None:
    """List the projects you belong to."""
    projects = _call(_client().get, "/api/projects")
    default = load_config().default_project
    for p in projects:
        mark = "*" if p["slug"] == default else " "
        typer.echo(f"{mark} {p['slug']:<20} {p['role']:<7} {p['members']} member(s), {p['documents']} file(s)")
    if not projects:
        typer.echo("No projects yet.")


@project_app.command("use")
def project_use(slug: str) -> None:
    """Make a project the default for commands and agents on this computer."""
    config = load_config()
    config.default_project = slug
    save_config(config)
    typer.echo(f"Default project: {slug}")


@project_app.command("add-member")
def project_add_member(
    slug: str,
    email: str,
    role: Annotated[str, typer.Option(help="owner, member or viewer")] = "member",
) -> None:
    """Give an existing team member access to a project."""
    result = _call(_client().post, f"/api/projects/{slug}/members", {"email": email, "role": role})
    typer.echo(f"{result['member']} is now {result['role']} of {slug}.")


@project_app.command("remove-member")
def project_remove_member(slug: str, email: str) -> None:
    """Remove someone's access to a project; their agents lose it immediately."""
    result = _call(_client().delete, f"/api/projects/{slug}/members/{email}")
    typer.echo(f"Removed {result['removed']} from {slug}.")


# ── Knowledge ─────────────────────────────────────────────────────────────────


def _list_files(root: Path) -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root,
            check=True,
            capture_output=True,
        ).stdout.decode()
        return [root / p for p in out.split("\0") if p]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [p for p in root.rglob("*") if p.is_file()]


@app.command()
def ingest(
    path: Annotated[Path, typer.Argument(help="Folder or file to add")] = Path("."),
    project: ProjectOpt = None,
) -> None:
    """Add a local folder's code and docs to a project (secrets never leave this computer)."""
    client = _client(timeout=600)
    slug = _call(client.resolve_project, project)
    root = path.resolve()
    candidates = [root] if root.is_file() else _list_files(root)
    base = root.parent if root.is_file() else root

    files, local_skips = [], []
    for file in candidates:
        rel = file.relative_to(base).as_posix()
        if not file.is_file():
            continue
        if reason := skip_reason(rel, file.stat().st_size):
            local_skips.append((rel, reason))
            continue
        try:
            content = file.read_text()
        except UnicodeDecodeError:
            local_skips.append((rel, "not text"))
            continue
        if not content.strip():
            local_skips.append((rel, "empty file"))
            continue
        if findings := scan_text(content):
            local_skips.append((rel, "contains secrets: " + findings[0].describe()))
            continue
        files.append({"path": rel, "content": content})

    batches, batch, size = [], [], 0
    for item in files:
        if batch and (len(batch) >= BATCH_FILES or size + len(item["content"]) > BATCH_BYTES):
            batches.append(batch)
            batch, size = [], 0
        batch.append(item)
        size += len(item["content"])
    if batch:
        batches.append(batch)

    totals = {"indexed": 0, "unchanged": 0, "chunks": 0}
    server_skips = []
    with typer.progressbar(batches, label=f"Uploading to {slug}") as progress:
        for i, chunk in enumerate(progress):
            report = _call(
                client.post,
                f"/api/projects/{slug}/documents",
                {
                    "files": chunk,
                    "source": f"local:{root.name}",
                    "refresh_brief": i == len(batches) - 1,
                },
            )
            for key in totals:
                totals[key] += report[key]
            server_skips += report["skipped_files"]
    typer.secho(
        f"{totals['indexed']} file(s) indexed, {totals['unchanged']} unchanged, "
        f"{totals['chunks']} chunk(s) into '{slug}'.",
        fg="green",
    )
    secret_skips = [s for s in local_skips if s[1].startswith(("contains secrets", "credential"))]
    if secret_skips:
        typer.secho(f"Kept on this computer ({len(secret_skips)}):", fg="yellow")
        for rel, reason in secret_skips:
            typer.echo(f"  {rel}: {reason}")
    for skip in server_skips:
        typer.echo(f"  skipped by server: {skip['path']}: {skip['reason']}")
    typer.echo(f"Skipped locally (empty, binary, lock, ignored): {len(local_skips) - len(secret_skips)}")


@app.command()
def github(
    repo: Annotated[str, typer.Argument(help="owner/name")],
    project: ProjectOpt = None,
    ref: Annotated[str | None, typer.Option(help="Branch, tag or commit")] = None,
) -> None:
    """Import a GitHub repository into a project (runs on the server; `loom watch` shows progress)."""
    client = _client()
    slug = _call(client.resolve_project, project)
    _call(
        client.post,
        f"/api/projects/{slug}/github",
        {"repo": repo, "ref": ref, "token": os.environ.get("GITHUB_TOKEN")},
    )
    typer.echo(f"Importing {repo} into {slug} in the background.")


@app.command()
def ask(
    question: str,
    project: ProjectOpt = None,
    path: Annotated[str | None, typer.Option(help="Restrict to a folder")] = None,
) -> None:
    """Ask the Conductor about your projects; answers cite their sources."""
    result = _call(
        _client().post,
        "/api/ask",
        {"query": question, "project": project, "path_prefix": path, "session_key": "cli"},
    )
    typer.echo(render.answer(result | {"question": question}))


@app.command()
def search(
    query: str,
    project: ProjectOpt = None,
    path: Annotated[str | None, typer.Option(help="Restrict to a folder")] = None,
) -> None:
    """Show the raw passages that match a query."""
    result = _call(_client().post, "/api/search", {"query": query, "project": project, "path_prefix": path})
    typer.echo(render.hits(result))


@app.command()
def brief(project: ProjectOpt = None) -> None:
    """Print a project's onboarding brief."""
    client = _client()
    slug = _call(client.resolve_project, project)
    typer.echo(_call(client.get, f"/api/projects/{slug}/brief")["brief"])


@app.command()
def note(
    title: str,
    text: Annotated[str | None, typer.Argument(help="Note text (or use --file)")] = None,
    file: Annotated[Path | None, typer.Option(help="Read the note from a file")] = None,
    project: ProjectOpt = None,
) -> None:
    """Save a decision or explanation to a project's knowledge."""
    content = file.read_text() if file else text
    if not content:
        _fail("Give the note text or --file.")
    client = _client()
    slug = _call(client.resolve_project, project)
    result = _call(client.post, f"/api/projects/{slug}/notes", {"title": title, "content": content})
    typer.echo(f"Saved as {result['path']} in {slug}.")


# ── Delivery ──────────────────────────────────────────────────────────────────


@app.command()
def send(
    to: Annotated[str, typer.Argument(help="Teammate name or email")],
    path: Annotated[Path | None, typer.Argument(help="File to send")] = None,
    message: Annotated[str | None, typer.Option("--message", "-m", help="Send a text message")] = None,
    kind: Annotated[str | None, typer.Option(help="file, skill or message")] = None,
    note: Annotated[str, typer.Option(help="Note for the recipient")] = "",
    project: ProjectOpt = None,
) -> None:
    """Send a file, an agent skill (SKILL.md) or a message to a teammate's inbox."""
    if path is None and message is None:
        _fail("Give a file path or --message.")
    if path is not None:
        if not path.is_file():
            _fail(f"No such file: {path}")
        content = path.read_text()
        kind = kind or ("skill" if path.name == "SKILL.md" else "file")
        filename = f"{path.resolve().parent.name}/{path.name}" if kind == "skill" else path.name
    else:
        content, kind, filename = message, "message", "message.txt"
    findings = scan_text(content) + scan_text(note)
    if is_sensitive_path(filename) or findings:
        reason = "credential file" if not findings else "; ".join(f.describe() for f in findings[:3])
        with contextlib.suppress(LoomError):
            _client().post(
                "/api/agent-events",
                {
                    "event": "share_blocked",
                    "decision": "deny",
                    "reason": reason,
                    "detail": {"to": to, "filename": filename, "where": "local"},
                },
            )
        _fail(f"Blocked on this computer, nothing was sent: {reason}")
    client = _client()
    result = _call(
        client.post,
        "/api/send",
        {
            "project": _call(client.resolve_project, project),
            "to": to,
            "filename": filename,
            "content": content,
            "kind": kind,
            "note": note,
        },
    )
    typer.secho(f"Sent {kind} '{result['delivery']['filename']}' to {result['recipient']}.", fg="green")


@app.command()
def inbox(
    all: Annotated[bool, typer.Option("--all", help="Include handled items")] = False,
) -> None:
    """List what teammates have sent you."""
    typer.echo(render.inbox(_call(_client().get, "/api/inbox", all=str(all).lower())))


@app.command()
def accept(
    delivery_id: str,
    to: Annotated[Path | None, typer.Option(help="Folder to place a file in")] = None,
) -> None:
    """Accept an inbox item and install it (skills go to Cursor and Claude Code)."""
    config = load_config()
    item = _call(_client(config).post, f"/api/inbox/{delivery_id}/accept")
    if item["kind"] == "message":
        typer.echo(f"Message from {item['from']}:\n{item['content']}")
        return
    for written in install(item, item["content"], config, to):
        typer.echo(f"Installed → {written}")


@app.command()
def decline(delivery_id: str) -> None:
    """Decline an inbox item."""
    item = _call(_client().post, f"/api/inbox/{delivery_id}/decline")
    typer.echo(f"Declined '{item['filename']}' from {item['from']}.")


@app.command()
def watch(
    feed: Annotated[bool, typer.Option(help="Also stream the team's audit log (admins)")] = False,
    window: Annotated[bool, typer.Option("--window", help="Run it in a new terminal window")] = False,
) -> None:
    """Stay online: messages, files and skills from teammates show up and open as they arrive."""
    from .watch import Watcher, open_watch_window, watch_running

    config = load_config()
    _client(config)
    if window:
        if watch_running():
            typer.echo("`loom watch` is already running in another window.")
        elif open_watch_window(connectors.executable(), connectors.custom_home()):
            typer.echo("Opened `loom watch` in a new terminal window.")
        else:
            typer.echo("No terminal app found; run `loom watch` in a new terminal.")
        return
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(Watcher(config, typer.echo, feed=feed).run())


# ── Governance ────────────────────────────────────────────────────────────────


@app.command()
def audit(
    limit: Annotated[int, typer.Option(help="How many recent events")] = 30,
    follow: Annotated[bool, typer.Option("--follow", "-f", help="Keep streaming new events")] = False,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Show what every agent in the team did, and what was denied (admins)."""
    from .watch import describe_audit

    events = _call(_client().get, "/api/audit", limit=limit)
    for event in events:
        typer.echo(json.dumps(event, default=str) if as_json else describe_audit(event))
    if follow:
        watch(feed=True)


@app.command()
def dashboard(
    no_open: Annotated[bool, typer.Option("--no-open", help="Only print the link")] = False,
) -> None:
    """Open the team dashboard in your browser (one-time link, valid for two minutes)."""
    config = load_config()
    link = _call(_client(config).post, "/api/dashboard/link")
    url = config.server_url + link["path"]
    if not no_open:
        webbrowser.open(url)
    typer.echo(f"Dashboard: {url}")


@app.command()
def devices() -> None:
    """List connected computers (all of them for admins)."""
    for d in _call(_client().get, "/api/devices"):
        state = "revoked" if d["revoked_at"] else f"last seen {str(d['last_seen_at'])[:16]}"
        client = f" via {d['last_client']}" if d["last_client"] else ""
        typer.echo(f"{d['id']}  {d['user']:<12} {d['name']:<24} {state}{client}")


@app.command()
def revoke(device_id: str) -> None:
    """Disconnect a computer; its agents lose access immediately."""
    result = _call(_client().post, f"/api/devices/{device_id}/revoke")
    typer.echo(f"Revoked {result['revoked']} ({result['user']}).")


# ── Agents ────────────────────────────────────────────────────────────────────


@app.command()
def connect(
    agent: Annotated[str, typer.Argument(help="cursor, claude (Claude Code), claude-desktop, or all")],
    project_dir: Annotated[Path | None, typer.Option(help="Connect only this project folder")] = None,
    hooks: Annotated[bool, typer.Option(help="Cursor: also install the prompt guard and audit hooks")] = False,
) -> None:
    """Connect AI agents on this computer to Loom AI (`all` connects every one it finds)."""
    if not load_config().token:
        _fail("Run `loom init` or `loom join` first.")
    supported = ("cursor", "claude", "claude-desktop")
    if agent == "all":
        agents = connectors.detect_agents()
        hooks = True
        if not agents:
            _fail("Found no Cursor, Claude Code or Claude desktop app on this computer.")
    elif agent in supported:
        agents = [agent]
    else:
        _fail("Supported agents: " + ", ".join(supported) + ", all")
    for name in agents:
        if name == "cursor":
            for change in connectors.connect_cursor(project_dir, hooks):
                typer.secho(f"✓ Cursor: {change}", fg="green")
        elif name == "claude":
            done, message = connectors.connect_claude()
            typer.secho(("✓ Claude Code: " if done else "") + message, fg="green" if done else "yellow")
        else:
            typer.secho(f"✓ Claude app: {connectors.connect_claude_desktop()}", fg="green")
    restart = {"cursor": "Cursor", "claude": "Claude Code", "claude-desktop": "the Claude app (quit it fully)"}
    typer.echo(f"Restart {', '.join(restart[a] for a in agents)}, then ask: “Loom, who am I?”")


@app.command()
def mcp() -> None:
    """Run the MCP server agents talk to (launched by Cursor / Claude Code over stdio)."""
    from .mcp_server import run

    run()


@hook_app.command("prompt-check")
def hook_prompt_check() -> None:
    from .hooks import prompt_check

    raise typer.Exit(prompt_check())


@hook_app.command("audit")
def hook_audit() -> None:
    from .hooks import audit as audit_hook

    raise typer.Exit(audit_hook())
