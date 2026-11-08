"""Split files into retrieval units that each carry a location (path, heading, line range)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath

MAX_CHARS = 2400
SMALL_FILE_CHARS = 2000
MIN_BLOCK_CHARS = 300
WINDOW_OVERLAP_LINES = 5

MARKDOWN_EXTENSIONS = {".md", ".mdx", ".markdown", ".mdc"}
LANGUAGES = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".go": "go", ".rs": "rust", ".java": "java",
    ".kt": "kotlin", ".swift": "swift", ".rb": "ruby", ".php": "php", ".cs": "csharp",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".scala": "scala", ".sql": "sql",
    ".sh": "shell", ".md": "markdown", ".mdx": "markdown", ".markdown": "markdown",
    ".mdc": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".html": "html", ".css": "css", ".tex": "latex", ".txt": "text",
}
_CODE_LANGUAGES = set(LANGUAGES.values()) - {"markdown", "json", "yaml", "toml", "text", "latex"}

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")
_DEFINITION = re.compile(
    r"^(?:async\s+def|def|class|function|interface|enum|struct|trait|impl|func|fn|module|"
    r"pub(?:\(crate\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|mod)|"
    r"export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)|"
    r"(?:public|private|protected|internal)\s+|type\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|"
    r"CREATE\s+(?:TABLE|INDEX|VIEW|FUNCTION))\b",
    re.IGNORECASE,
)
_PREFIX_LINE = re.compile(r"^(?:@|#|//|/\*|\*|--)")


@dataclass(frozen=True)
class Chunk:
    heading: str | None
    start_line: int
    end_line: int
    text: str


@dataclass(frozen=True)
class _Block:
    heading: str | None
    start: int  # 0-based, inclusive
    end: int  # 0-based, inclusive


def language_for(path: str) -> str | None:
    return LANGUAGES.get(PurePosixPath(path).suffix.lower())


def chunk_document(path: str, text: str) -> list[Chunk]:
    lines = text.splitlines()
    if not any(line.strip() for line in lines):
        return []
    if len(text) <= SMALL_FILE_CHARS:
        return [Chunk(heading=None, start_line=1, end_line=len(lines), text=text.strip("\n"))]

    suffix = PurePosixPath(path).suffix.lower()
    if suffix in MARKDOWN_EXTENSIONS:
        blocks = _markdown_sections(lines)
    elif language_for(path) in _CODE_LANGUAGES:
        blocks = _code_blocks(lines)
    else:
        blocks = [_Block(heading=None, start=0, end=len(lines) - 1)]
    return _pack(blocks, lines)


def _markdown_sections(lines: list[str]) -> list[_Block]:
    blocks: list[_Block] = []
    stack: list[tuple[int, str]] = []
    start, heading, in_fence = 0, None, False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        match = None if in_fence else _HEADING.match(line)
        if not match:
            continue
        if i > start:
            blocks.append(_Block(heading, start, i - 1))
        level, title = len(match.group(1)), match.group(2)
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        start, heading = i, " > ".join(t for _, t in stack)
    blocks.append(_Block(heading, start, len(lines) - 1))
    return blocks


def _code_blocks(lines: list[str]) -> list[_Block]:
    boundaries: list[int] = []
    for i, line in enumerate(lines):
        if line[:1].isspace() or not _DEFINITION.match(line):
            continue
        start = i
        while start > 0 and lines[start - 1].strip() and _PREFIX_LINE.match(lines[start - 1]):
            start -= 1
        if not boundaries or start > boundaries[-1]:
            boundaries.append(start)
    if not boundaries or boundaries[0] != 0:
        boundaries.insert(0, 0)

    blocks: list[_Block] = []
    for index, start in enumerate(boundaries):
        end = boundaries[index + 1] - 1 if index + 1 < len(boundaries) else len(lines) - 1
        signature = next(
            (ln.strip() for ln in lines[start : end + 1] if _DEFINITION.match(ln)), None
        )
        blocks.append(_Block(_signature_label(signature) if signature else None, start, end))
    return blocks


def _signature_label(line: str) -> str:
    """``def send(`` (a signature continued on later lines) becomes ``def send(…)``."""
    label = line.rstrip(":{ ")
    if label.count("(") > label.count(")"):
        label = label[: label.index("(")] + "(…)"
    return label[:120]


def _size(lines: list[str], block: _Block) -> int:
    return sum(len(line) + 1 for line in lines[block.start : block.end + 1])


def _pack(blocks: list[_Block], lines: list[str]) -> list[Chunk]:
    """Merge neighbouring small blocks and window oversized ones."""
    merged: list[_Block] = []
    for block in blocks:
        if merged:
            previous = merged[-1]
            prev_size, size = _size(lines, previous), _size(lines, block)
            if (prev_size < MIN_BLOCK_CHARS or size < MIN_BLOCK_CHARS) and prev_size + size <= MAX_CHARS:
                merged[-1] = _Block(previous.heading or block.heading, previous.start, block.end)
                continue
        merged.append(block)

    chunks: list[Chunk] = []
    for block in merged:
        for start, end in _windows(lines, block.start, block.end):
            text = "\n".join(lines[start : end + 1]).strip("\n")
            if text.strip():
                chunks.append(Chunk(block.heading, start + 1, end + 1, text))
    return chunks


def _windows(lines: list[str], start: int, end: int) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    cursor = start
    while cursor <= end:
        size, stop = 0, cursor
        while stop <= end and (size == 0 or size + len(lines[stop]) + 1 <= MAX_CHARS):
            size += len(lines[stop]) + 1
            stop += 1
        windows.append((cursor, stop - 1))
        if stop > end:
            break
        cursor = max(stop - WINDOW_OVERLAP_LINES, cursor + 1)
    return windows
