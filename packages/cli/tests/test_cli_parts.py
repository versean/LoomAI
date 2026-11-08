import json

import pytest

from loom_cli import connect, watch
from loom_cli.config import Config
from loom_cli.hooks import _snake
from loom_cli.installer import install


def _config(tmp_path) -> Config:
    return Config(
        skill_dirs=[str(tmp_path / "cursor"), str(tmp_path / "claude")], inbox_dir=str(tmp_path / "inbox")
    )


def test_skill_installs_into_every_agent(tmp_path):
    item = {"kind": "skill", "filename": "demo", "install_path": "skills/demo/SKILL.md", "from": "Alice"}
    written = install(item, "# skill", _config(tmp_path))
    assert sorted(p.parent.parent.name for p in written) == ["claude", "cursor"]
    assert all(p.read_text() == "# skill" for p in written)


def test_reinstall_keeps_a_backup(tmp_path):
    item = {"kind": "file", "filename": "notes.md", "install_path": "notes.md", "from": "Bob"}
    install(item, "v1", _config(tmp_path))
    install(item, "v2", _config(tmp_path))
    folder = tmp_path / "inbox" / "Bob"
    assert (folder / "notes.md").read_text() == "v2"
    assert [p.read_text() for p in folder.glob("notes.md.bak-*")] == ["v1"]


def test_install_never_escapes_target(tmp_path):
    item = {"kind": "file", "filename": "x", "install_path": "../../outside.txt", "from": "Eve"}
    with pytest.raises(ValueError):
        install(item, "boom", _config(tmp_path), project_dir=tmp_path / "project")
    assert not (tmp_path / "outside.txt").exists()


class _FakeInboxClient:
    def __init__(self, waiting, contents):
        self.waiting, self.contents, self.accepted = waiting, contents, []

    def get(self, path, **params):
        assert path == "/api/inbox"
        return self.waiting

    def post(self, path):
        delivery_id = path.split("/")[3]
        self.accepted.append(delivery_id)
        item = next(i for i in self.waiting if i["id"] == delivery_id)
        return item | {"content": self.contents[delivery_id]}


def test_watch_opens_waiting_messages_and_files_without_accept(tmp_path, monkeypatch):
    monkeypatch.setattr(watch, "notify", lambda *args: None)
    base = {"note": "", "project": "app", "from": "Alice"}
    waiting = [  # newest first, as /api/inbox returns them
        base | {"id": "f1", "kind": "file", "filename": "plan.md", "install_path": "plan.md"},
        base | {"id": "m1", "kind": "message", "filename": "message.txt", "install_path": None},
    ]
    lines = []
    watcher = watch.Watcher(_config(tmp_path), lines.append)
    watcher.client = _FakeInboxClient(waiting, {"m1": "Hello world", "f1": "# Plan"})

    assert watcher.handle({"type": "hello", "user": "Bob", "device": "laptop"})

    assert watcher.client.accepted == ["m1", "f1"]
    assert "   Hello world" in lines
    assert (tmp_path / "inbox" / "Alice" / "plan.md").read_text() == "# Plan"


def test_hook_event_names_become_snake_case():
    assert _snake("afterMCPExecution") == "after_mcp_execution"
    assert _snake("beforeSubmitPrompt") == "before_submit_prompt"


def test_connect_claude_desktop_keeps_other_servers(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))  # Path.home() on Windows
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData"))  # Claude desktop config on Windows
    monkeypatch.setenv("LOOM_HOME", str(tmp_path / ".loom"))
    monkeypatch.setattr(connect, "executable", lambda: "/opt/loom")
    path = connect.claude_desktop_config()
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}, "theme": "dark"}))

    assert "claude-desktop" in connect.detect_agents()
    connect.connect_claude_desktop()

    config = json.loads(path.read_text())
    assert config["theme"] == "dark"
    assert config["mcpServers"] == {"other": {"command": "x"}, "loom": {"command": "/opt/loom", "args": ["mcp"]}}


def test_connect_cursor_merges_existing_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))  # Path.home() on Windows
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData"))  # Claude desktop config on Windows
    monkeypatch.setenv("LOOM_HOME", str(tmp_path / ".loom"))
    monkeypatch.setattr(connect, "executable", lambda: "/opt/loom")
    cursor = tmp_path / ".cursor"
    cursor.mkdir()
    (cursor / "mcp.json").write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}))
    (cursor / "hooks.json").write_text(json.dumps({"version": 1, "hooks": {"stop": [{"command": "mine"}]}}))

    connect.connect_cursor(None, hooks=True)
    connect.connect_cursor(None, hooks=True)

    servers = json.loads((cursor / "mcp.json").read_text())["mcpServers"]
    assert servers["other"] == {"command": "x"}
    assert servers["loom"] == {"command": "/opt/loom", "args": ["mcp"]}
    hooks = json.loads((cursor / "hooks.json").read_text())["hooks"]
    assert [h["command"] for h in hooks["stop"]] == ["mine", "/opt/loom hook audit"]
    assert hooks["beforeSubmitPrompt"] == [{"command": "/opt/loom hook prompt-check"}]
