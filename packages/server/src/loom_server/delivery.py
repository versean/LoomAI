"""Store-and-forward delivery of files, skills and messages between teammates."""

from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath
from uuid import UUID

import psycopg

from loom_common.secrets import is_sensitive_path, scan_text

from .auth import Actor
from .blobs import get_blob_store
from .config import get_settings
from .errors import InvalidRequest, NotFound, PolicyDenied
from .events import bus
from .policy import Project, decide_share
from .providers.guardrails import get_guardrail

KINDS = ("file", "skill", "message")
_SKILL_NAME = re.compile(r"[^a-z0-9-]+")


def _find_member(conn: psycopg.Connection, actor: Actor, who: str) -> dict:
    who = who.strip()
    rows = conn.execute(
        """
        SELECT id, email, display_name FROM users
        WHERE workspace_id = %s AND (lower(email) = lower(%s) OR lower(display_name) = lower(%s))
        """,
        (actor.workspace_id, who, who),
    ).fetchall()
    if not rows:
        rows = conn.execute(
            """
            SELECT id, email, display_name FROM users
            WHERE workspace_id = %s AND lower(display_name) LIKE lower(%s) || ' %%'
            """,
            (actor.workspace_id, who),
        ).fetchall()
    if not rows:
        raise NotFound(f"Nobody called '{who}' in this team")
    if len(rows) > 1:
        options = ", ".join(r["email"] for r in rows)
        raise InvalidRequest(f"'{who}' is ambiguous, use an email: {options}")
    return rows[0]


def default_install_path(kind: str, filename: str) -> str | None:
    if kind == "message":
        return None
    if kind == "skill":
        stem = PurePosixPath(filename).parent.name if PurePosixPath(filename).name == "SKILL.md" else ""
        name = _SKILL_NAME.sub("-", (stem or PurePosixPath(filename).stem).lower()).strip("-") or "skill"
        return f"skills/{name}/SKILL.md"
    return PurePosixPath(filename).name


def _validate_install_path(path: str | None) -> str | None:
    if path is None:
        return None
    pure = PurePosixPath(path.replace("\\", "/"))
    if pure.is_absolute() or ".." in pure.parts or not pure.parts:
        raise InvalidRequest("install_path must be a relative path without '..'")
    return str(pure)


def send(
    conn: psycopg.Connection,
    actor: Actor,
    project: Project,
    *,
    to: str,
    filename: str,
    content: str,
    kind: str,
    note: str,
    install_path: str | None,
) -> dict:
    if kind not in KINDS:
        raise InvalidRequest(f"kind must be one of {KINDS}")
    data = content.encode()
    if len(data) > get_settings().max_artifact_bytes:
        raise InvalidRequest("Artifact is larger than the 1 MB limit")

    recipient = _find_member(conn, actor, to)
    recipient_role = conn.execute(
        "SELECT role FROM memberships WHERE project_id = %s AND user_id = %s",
        (project.id, recipient["id"]),
    ).fetchone()

    reason = decide_share(
        sender_role=project.role,
        device_scopes=actor.scopes,
        recipient_role=recipient_role["role"] if recipient_role else None,
        recipient_is_sender=recipient["id"] == actor.user_id,
        sensitive_path=is_sensitive_path(filename),
        findings=scan_text(content) + scan_text(note),
    )
    if reason is None and (guardrail := get_guardrail()):
        reason = guardrail.check(f"{note}\n\n{content}")
    if reason:
        raise PolicyDenied(f"Not sent to {recipient['display_name']}: {reason}")

    install = _validate_install_path(install_path) or default_install_path(kind, filename)
    shown_name = PurePosixPath(install).parent.name if kind == "skill" else PurePosixPath(filename).name
    content_hash = hashlib.sha256(data).hexdigest()
    blob_key = f"projects/{project.id}/artifacts/{content_hash}"
    get_blob_store().put(blob_key, data)

    artifact_id = conn.execute(
        """
        INSERT INTO artifacts (project_id, sender_id, kind, filename, install_path, blob_key, content_hash, size_bytes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """,
        (project.id, actor.user_id, kind, shown_name, install, blob_key,
         content_hash, len(data)),
    ).fetchone()["id"]
    delivery = conn.execute(
        """
        INSERT INTO deliveries (artifact_id, recipient_id, note) VALUES (%s, %s, %s)
        RETURNING id, created_at
        """,
        (artifact_id, recipient["id"], note),
    ).fetchone()

    item = {
        "id": str(delivery["id"]),
        "kind": kind,
        "filename": shown_name,
        "install_path": install,
        "note": note,
        "project": project.slug,
        "from": actor.display_name,
        "from_email": actor.email,
        "size_bytes": len(data),
        "created_at": delivery["created_at"].isoformat(),
        "status": "new",
    }
    conn.commit()
    bus.to_user(recipient["id"], {"type": "delivery.new", "delivery": item})
    return {"delivery": item, "recipient": recipient["display_name"]}


_INBOX_SQL = """
SELECT d.id, d.note, d.status, d.created_at, a.kind, a.filename, a.install_path, a.size_bytes,
       a.blob_key, p.slug AS project, s.display_name AS sender, s.email AS sender_email, s.id AS sender_id
FROM deliveries d
JOIN artifacts a ON a.id = d.artifact_id
JOIN projects p ON p.id = a.project_id
JOIN users s ON s.id = a.sender_id
WHERE d.recipient_id = %(user_id)s
"""


def _item(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        "filename": row["filename"],
        "install_path": row["install_path"],
        "note": row["note"],
        "project": row["project"],
        "from": row["sender"],
        "from_email": row["sender_email"],
        "size_bytes": row["size_bytes"],
        "created_at": row["created_at"].isoformat(),
        "status": row["status"],
    }


def inbox(conn: psycopg.Connection, actor: Actor, *, include_handled: bool = False) -> list[dict]:
    sql = _INBOX_SQL + ("" if include_handled else " AND d.status = 'new'") + " ORDER BY d.created_at DESC LIMIT 50"
    return [_item(r) for r in conn.execute(sql, {"user_id": actor.user_id}).fetchall()]


def _own_delivery(conn: psycopg.Connection, actor: Actor, delivery_id: UUID) -> dict:
    row = conn.execute(_INBOX_SQL + " AND d.id = %(id)s", {"user_id": actor.user_id, "id": delivery_id}).fetchone()
    if row is None:
        raise NotFound("No such item in your inbox")
    return row


def accept(conn: psycopg.Connection, actor: Actor, delivery_id: UUID) -> dict:
    row = _own_delivery(conn, actor, delivery_id)
    if row["status"] == "declined":
        raise InvalidRequest("This item was declined")
    content = get_blob_store().get(row["blob_key"]).decode()
    conn.execute(
        "UPDATE deliveries SET status = 'accepted', acted_at = coalesce(acted_at, now()) WHERE id = %s",
        (delivery_id,),
    )
    conn.commit()
    item = _item(row) | {"status": "accepted"}
    bus.to_user(row["sender_id"], {"type": "delivery.accepted", "delivery": item, "by": actor.display_name})
    return item | {"content": content}


def decline(conn: psycopg.Connection, actor: Actor, delivery_id: UUID) -> dict:
    row = _own_delivery(conn, actor, delivery_id)
    conn.execute(
        "UPDATE deliveries SET status = 'declined', acted_at = now() WHERE id = %s AND status = 'new'",
        (delivery_id,),
    )
    conn.commit()
    item = _item(row) | {"status": "declined"}
    bus.to_user(row["sender_id"], {"type": "delivery.declined", "delivery": item, "by": actor.display_name})
    return item
