"""Writes accepted deliveries to disk without ever escaping their target folder."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path, PurePosixPath

from .config import Config

_UNSAFE = re.compile(r"[^A-Za-z0-9._ -]+")


def _safe_join(base: Path, relative: str) -> Path:
    base = base.expanduser().resolve()
    target = (base / PurePosixPath(relative)).resolve()
    if not target.is_relative_to(base):
        raise ValueError(f"Refusing to write outside {base}: {relative}")
    return target


def _write(target: Path, content: str) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_text(errors="replace") != content:
        backup = target.with_name(f"{target.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
        target.rename(backup)
    target.write_text(content)
    return target


def install(item: dict, content: str, config: Config, project_dir: Path | None = None) -> list[Path]:
    """Place an accepted delivery where its kind belongs and return the written paths.

    Skills go into every configured skills folder (Cursor and Claude Code by default);
    files go into the project folder when given, otherwise into the Loom inbox folder.
    Earlier versions are kept as ``.bak-<timestamp>`` files.
    """
    kind = item["kind"]
    if kind == "message":
        return []
    install_path = item.get("install_path") or item["filename"]
    if kind == "skill":
        relative = install_path.removeprefix("skills/")
        return [_write(_safe_join(Path(d), relative), content) for d in config.skill_dirs]
    if project_dir is not None:
        return [_write(_safe_join(project_dir, install_path), content)]
    sender = _UNSAFE.sub("_", item.get("from") or "unknown").strip() or "unknown"
    return [_write(_safe_join(Path(config.inbox_dir) / sender, item["filename"]), content)]
