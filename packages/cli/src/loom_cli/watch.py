"""``loom watch``: live pushes from Loom AI, desktop notifications, automatic skill installs."""

from __future__ import annotations

import asyncio
import json
import platform
import shlex
import shutil
import subprocess
from collections.abc import Callable

import websockets

from .client import LoomClient, LoomError
from .config import Config, home_dir
from .installer import install


def notify(title: str, message: str) -> None:
    if platform.system() != "Darwin":
        return
    script = f"display notification {json.dumps(message)} with title {json.dumps(title)}"
    subprocess.run(["osascript", "-e", script], check=False, capture_output=True)


def watch_running() -> bool:
    return subprocess.run(["pgrep", "-f", "loom watch$"], check=False, capture_output=True).returncode == 0


def open_watch_window(loom: str, loom_home: str | None) -> bool:
    """Start `loom watch` in a new terminal window; returns False if no terminal app was found."""
    command = [loom, "watch"]
    if platform.system() == "Darwin":
        script = home_dir() / "watch.command"
        script.parent.mkdir(parents=True, exist_ok=True)
        env = f"export LOOM_HOME={shlex.quote(loom_home)}\n" if loom_home else ""
        script.write_text(f"#!/bin/sh\n{env}clear\nexec {shlex.join(command)}\n")
        script.chmod(0o755)
        return subprocess.run(["open", str(script)], check=False, capture_output=True).returncode == 0
    for terminal in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm"):
        if shutil.which(terminal):
            flag = "--" if terminal == "gnome-terminal" else "-e"
            subprocess.Popen([terminal, flag, *command], start_new_session=True)
            return True
    return False


AUDIT_DETAIL_KEYS = (
    "to", "filename", "question", "query", "path", "title", "repo", "email", "mcp_server_name", "tool_name",
)


def describe_audit(event: dict) -> str:
    """One line per audit event, from either a live push or a row of ``/api/audit``."""
    who = event.get("actor")
    if who is None:
        who = event.get("user") or "system"
        if event.get("device"):
            who += f" ({event['device']}" + (f" via {event['client']})" if event.get("client") else ")")
    mark = {"allow": "✓", "deny": "✗", "error": "!"}.get(event["decision"], "?")
    line = f"{str(event.get('at', ''))[11:19]} {mark} {event['action']:<22} {who}"
    if event.get("project"):
        line += f" [{event['project']}]"
    detail = event.get("detail") or {}
    shown = [f"{k}={str(detail[k])[:60]}" for k in AUDIT_DETAIL_KEYS if detail.get(k)]
    if shown:
        line += " " + " ".join(shown[:3])
    if event.get("reason"):
        line += f": {event['reason']}"
    return line


class Watcher:
    def __init__(self, config: Config, echo: Callable[[str], None], feed: bool = False):
        self.config = config
        self.echo = echo
        self.feed = feed
        self.client = LoomClient(config, client_name="loom-watch")

    def _auto_accept(self, item: dict) -> None:
        try:
            accepted = self.client.post(f"/api/inbox/{item['id']}/accept")
        except LoomError as error:
            self.echo(f"   could not open it: {error.reason}")
            return
        sender = accepted["from"]
        if accepted["kind"] == "message":
            self.echo("   " + accepted["content"].replace("\n", "\n   "))
            notify(f"Message from {sender}", accepted["content"][:200])
            return
        for path in install(accepted, accepted["content"], self.config):
            self.echo(f"   saved → {path}")
        what = "Installed skill" if accepted["kind"] == "skill" else "Saved file"
        notify("Loom AI", f"{what} '{accepted['filename']}' from {sender}")

    def _show_delivery(self, item: dict) -> None:
        icon = {"message": "💬", "skill": "🧩"}.get(item["kind"], "📄")
        title = "message" if item["kind"] == "message" else f"{item['kind']} '{item['filename']}'"
        self.echo(f"{icon} {item['from']} sent a {title} (project {item['project']})")
        if item["note"]:
            self.echo(f"   note: {item['note']}")
        automatic = self.config.auto_install_skills if item["kind"] == "skill" else self.config.auto_accept
        if automatic:
            self._auto_accept(item)
        else:
            notify("Loom AI", f"{item['from']} sent you {item['filename']}")
            self.echo(f"   accept with: loom accept {item['id']}")

    def _show_waiting(self) -> None:
        try:
            waiting = self.client.get("/api/inbox", all="false")
        except LoomError as error:
            self.echo(f"Could not read your inbox: {error.reason}")
            return
        if waiting:
            self.echo(f"While you were away ({len(waiting)}):")
        for item in reversed(waiting):
            self._show_delivery(item)

    def handle(self, event: dict) -> bool:
        """Process one pushed event; returns False when watching should stop."""
        kind = event.get("type")
        if kind == "hello":
            self.echo(f"Watching as {event['user']} on {event['device']}. Ctrl+C to stop.")
            self._show_waiting()
        elif kind == "delivery.new":
            self._show_delivery(event["delivery"])
        elif kind in ("delivery.accepted", "delivery.declined"):
            verb = kind.split(".")[1]
            self.echo(f"↩ {event['by']} {verb} '{event['delivery']['filename']}'")
            notify("Loom AI", f"{event['by']} {verb} {event['delivery']['filename']}")
        elif kind == "ingest.done":
            report = event["report"]
            self.echo(
                f"📚 {event['repo']} indexed into {event['project']}: "
                f"{report['indexed']} new/changed, {report['unchanged']} unchanged, "
                f"{report['chunks']} chunks, {report['skipped']} skipped"
            )
            notify("Loom AI", f"{event['repo']} is ready in {event['project']}")
        elif kind == "ingest.failed":
            self.echo(f"⚠ {event['repo']} import failed: {event['reason']}")
        elif kind == "device.revoked":
            self.echo(f"⛔ This device ({event['device']}) was revoked by an admin.")
            notify("Loom AI", "This device was disconnected by an admin")
            return False
        elif kind == "audit" and self.feed:
            self.echo(describe_audit(event["event"]))
        return True

    async def run(self) -> None:
        delay = 1
        while True:
            try:
                async with websockets.connect(self.client.websocket_url(), ping_interval=None) as ws:
                    delay = 1
                    async for raw in ws:
                        event = json.loads(raw)
                        keep_going = await asyncio.to_thread(self.handle, event)
                        if not keep_going:
                            return
            except websockets.InvalidStatus as error:
                self.echo(f"Loom AI rejected the connection ({error.response.status_code}).")
                return
            except websockets.ConnectionClosedError as error:
                if error.rcvd and error.rcvd.code == 4401:
                    self.echo("This device's token is no longer valid. Run `loom join` again.")
                    return
                self.echo(f"Connection lost, retrying in {delay}s…")
            except OSError:
                self.echo(f"Loom AI unreachable at {self.config.server_url}, retrying in {delay}s…")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)
