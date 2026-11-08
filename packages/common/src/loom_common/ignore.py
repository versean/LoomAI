"""Which files are never indexed or uploaded; shared so the CLI skips them before upload."""

from __future__ import annotations

from pathlib import PurePosixPath

from .secrets import is_sensitive_path

SKIP_DIRS = frozenset({
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".turbo",
    ".cache", "target", ".idea", ".mypy_cache", ".pytest_cache", ".ruff_cache", "coverage",
    "vendor", ".gradle", "Pods", "DerivedData",
})
SKIP_FILES = frozenset({
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Cargo.lock",
    "composer.lock", "Gemfile.lock", ".DS_Store",
})
BINARY_SUFFIXES = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".svg", ".pdf", ".zip", ".gz",
    ".tar", ".tgz", ".7z", ".rar", ".mp3", ".mp4", ".mov", ".wav", ".woff", ".woff2", ".ttf",
    ".otf", ".eot", ".pyc", ".so", ".dylib", ".dll", ".exe", ".bin", ".class", ".jar", ".db",
    ".sqlite", ".parquet", ".pkl", ".pt", ".onnx", ".safetensors", ".npy", ".xlsx", ".docx",
})
DEFAULT_MAX_BYTES = 400_000


def skip_reason(path: str, size: int, max_bytes: int = DEFAULT_MAX_BYTES) -> str | None:
    """Why ``path`` should not be indexed, judged from its path and size alone."""
    parts = PurePosixPath(path.replace("\\", "/")).parts
    if any(part in SKIP_DIRS for part in parts[:-1]):
        return "ignored directory"
    name = parts[-1]
    if name in SKIP_FILES:
        return "lock file"
    if PurePosixPath(name).suffix.lower() in BINARY_SUFFIXES:
        return "binary file"
    if is_sensitive_path(path):
        return "credential file, never indexed"
    if size > max_bytes:
        return "file too large"
    return None
