"""Turn files into searchable knowledge: screen, chunk, embed and store them atomically."""

from __future__ import annotations

import hashlib
import io
import re
import tarfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import PurePosixPath
from uuid import UUID

import httpx
import psycopg

from loom_common import ignore
from loom_common.secrets import scan_text

from .blobs import get_blob_store
from .chunking import chunk_document, language_for
from .config import get_settings
from .errors import InvalidRequest
from .providers.embeddings import get_embedder

_REPO = re.compile(r"^[\w.-]+/[\w.-]+$")


@dataclass(frozen=True)
class FileInput:
    path: str
    content: str


@dataclass
class IngestReport:
    indexed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    chunks: int = 0

    def summary(self) -> dict[str, int]:
        return {
            "indexed": len(self.indexed),
            "unchanged": len(self.unchanged),
            "removed": len(self.removed),
            "skipped": len(self.skipped),
            "chunks": self.chunks,
        }


def normalize_path(path: str) -> str:
    parts = [p for p in PurePosixPath(path.replace("\\", "/")).parts if p not in ("/", ".", "")]
    if not parts or ".." in parts:
        raise InvalidRequest(f"Invalid path: {path!r}")
    return "/".join(parts)


def skip_reason(path: str, size: int) -> str | None:
    return ignore.skip_reason(path, size, get_settings().max_file_bytes)


def _search_text(path: str, heading: str | None, text: str) -> str:
    header = f"File: {path}\n" + (f"Section: {heading}\n" if heading else "")
    return header + text


def ingest_files(
    conn: psycopg.Connection,
    *,
    project_id: UUID,
    user_id: UUID | None,
    files: list[FileInput],
    source: str,
    kind: str = "file",
    prune_missing: bool = False,
) -> IngestReport:
    report = IngestReport()
    pending: list[tuple[str, str, str, list]] = []

    for item in files:
        path = normalize_path(item.path)
        data = item.content.encode()
        reason = skip_reason(path, len(data))
        if reason is None and "\x00" in item.content:
            reason = "binary file"
        if reason is None and (findings := scan_text(item.content)):
            reason = "contains secrets, not indexed: " + ", ".join(sorted({f.rule for f in findings}))
        if reason:
            report.skipped.append({"path": path, "reason": reason})
            continue

        content_hash = hashlib.sha256(data).hexdigest()
        existing = conn.execute(
            "SELECT content_hash FROM documents WHERE project_id = %s AND path = %s",
            (project_id, path),
        ).fetchone()
        if existing and existing["content_hash"] == content_hash:
            report.unchanged.append(path)
            continue
        chunks = chunk_document(path, item.content)
        if not chunks:
            report.skipped.append({"path": path, "reason": "empty file"})
            continue
        pending.append((path, item.content, content_hash, chunks))

    embedder = get_embedder()
    texts = [_search_text(path, c.heading, c.text) for path, _, _, chunks in pending for c in chunks]
    vectors = iter(embedder.embed_documents(texts)) if texts else iter(())
    blobs = get_blob_store()

    for path, content, content_hash, chunks in pending:
        blob_key = f"projects/{project_id}/files/{content_hash}"
        blobs.put(blob_key, content.encode())
        with conn.transaction():
            document_id = conn.execute(
                """
                INSERT INTO documents
                    (project_id, path, kind, source, content_hash, blob_key, size_bytes, language, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (project_id, path) DO UPDATE SET
                    kind = EXCLUDED.kind, source = EXCLUDED.source,
                    content_hash = EXCLUDED.content_hash, blob_key = EXCLUDED.blob_key,
                    size_bytes = EXCLUDED.size_bytes, language = EXCLUDED.language,
                    updated_at = now()
                RETURNING id
                """,
                (project_id, path, kind, source, content_hash, blob_key, len(content.encode()),
                 language_for(path), user_id),
            ).fetchone()["id"]
            conn.execute("DELETE FROM chunks WHERE document_id = %s", (document_id,))
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO chunks (document_id, project_id, path, ordinal, heading,
                                        start_line, end_line, content, embedding, embed_model)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        (document_id, project_id, path, ordinal, c.heading, c.start_line,
                         c.end_line, c.text, next(vectors), embedder.name)
                        for ordinal, c in enumerate(chunks)
                    ],
                )
        report.indexed.append(path)
        report.chunks += len(chunks)

    if prune_missing:
        seen = [normalize_path(f.path) for f in files]
        rows = conn.execute(
            "DELETE FROM documents WHERE project_id = %s AND source = %s AND NOT (path = ANY(%s)) RETURNING path",
            (project_id, source, seen),
        ).fetchall()
        report.removed = [r["path"] for r in rows]
    return report


def note_path(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "note"
    return f"notes/{datetime.now(UTC):%Y-%m-%d}-{slug}.md"


def fetch_github_snapshot(repo: str, ref: str | None, token: str | None) -> tuple[list[FileInput], list[dict]]:
    """Download a repository tarball and return its text files plus the ones skipped."""
    if not _REPO.match(repo):
        raise InvalidRequest("Repository must look like 'owner/name'")
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"https://api.github.com/repos/{repo}/tarball" + (f"/{ref}" if ref else "")
    response = httpx.get(url, headers=headers, follow_redirects=True, timeout=120)
    if response.status_code == 404:
        raise InvalidRequest(f"Repository {repo} not found (private repos need a GitHub token)")
    response.raise_for_status()

    files: list[FileInput] = []
    skipped: list[dict] = []
    with tarfile.open(fileobj=io.BytesIO(response.content), mode="r:gz") as archive:
        for member in archive:
            if not member.isfile():
                continue
            path = member.name.split("/", 1)[1] if "/" in member.name else member.name
            reason = skip_reason(path, member.size)
            if reason:
                if reason != "ignored directory":
                    skipped.append({"path": path, "reason": reason})
                continue
            raw = archive.extractfile(member)
            if raw is None:
                continue
            try:
                files.append(FileInput(path=path, content=raw.read().decode("utf-8")))
            except UnicodeDecodeError:
                skipped.append({"path": path, "reason": "binary file"})
    return files, skipped
