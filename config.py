"""Per-computer settings in ``~/.loom/config.json`` (``LOOM_HOME`` gives a second identity)."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

HOSTED_SERVER = "https://d1a5peogdvb7j1.cloudfront.net"


def home_dir() -> Path:
    return Path(os.environ.get("LOOM_HOME", Path.home() / ".loom")).expanduser()


def config_path() -> Path:
    return home_dir() / "config.json"


@dataclass
class Config:
    server_url: str = HOSTED_SERVER
    token: str | None = None
    user: str | None = None
    team: str | None = None
    default_project: str | None = None
    auto_install_skills: bool = True
    auto_accept: bool = True  # `loom watch` opens messages and saves files to inbox_dir as they arrive
    skill_dirs: list[str] = field(default_factory=lambda: ["~/.cursor/skills", "~/.claude/skills"])
    inbox_dir: str = "~/Loom/inbox"

    @property
    def logged_in(self) -> bool:
        return bool(self.token)


def load_config() -> Config:
    path = config_path()
    config = Config()
    if path.exists():
        data = json.loads(path.read_text())
        known = {k: v for k, v in data.items() if k in Config.__dataclass_fields__}
        config = Config(**known)
    config.server_url = os.environ.get("LOOM_SERVER_URL", config.server_url).rstrip("/")
    config.token = os.environ.get("LOOM_TOKEN", config.token)
    return config


def save_config(config: Config) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(config), indent=2))
    tmp.chmod(0o600)
    tmp.replace(path)
    return path
