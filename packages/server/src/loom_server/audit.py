from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from .auth import Actor
from .db import connection
from .errors import PolicyDenied
from .events import bus


@dataclass
class AuditScope:
    project_id: UUID | None = None
    detail: dict[str, Any] = field(default_factory=dict)


def record(
    actor: Actor | None,
    action: str,
    decision: str,
    *,
    reason: str | None = None,
    project_id: UUID | None = None,
    detail: dict[str, Any] | None = None,
    latency_ms: int | None = None,
    workspace_id: UUID | None = None,
) -> None:
    workspace_id = actor.workspace_id if actor else workspace_id
    with connection() as conn:
        row = conn.execute(
            """
            INSERT INTO audit_events
                (workspace_id, user_id, device_id, client, action, project_id,
                 decision, reason, latency_ms, detail)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, at, (SELECT slug FROM projects p WHERE p.id = project_id) AS project
            """,
            (
                workspace_id,
                actor.user_id if actor else None,
                actor.device_id if actor else None,
                actor.client if actor else None,
                action,
                project_id,
                decision,
                reason,
                latency_ms,
                Jsonb(detail or {}),
            ),
        ).fetchone()
    if workspace_id is not None:
        bus.to_admins(
            workspace_id,
            {
                "type": "audit",
                "event": {
                    "id": row["id"],
                    "at": row["at"].isoformat(),
                    "actor": actor.label() if actor else None,
                    "user": actor.display_name if actor else None,
                    "device": actor.device_name if actor else None,
                    "client": actor.client if actor else None,
                    "action": action,
                    "project": row["project"],
                    "decision": decision,
                    "reason": reason,
                    "latency_ms": latency_ms,
                    "detail": detail or {},
                },
            },
        )


@contextmanager
def audited(actor: Actor, action: str, **detail: Any) -> Iterator[AuditScope]:
    """Record one audit event for the enclosed operation, whatever its outcome."""
    scope = AuditScope(detail={k: v for k, v in detail.items() if v is not None})
    started = time.perf_counter()

    def elapsed() -> int:
        return int((time.perf_counter() - started) * 1000)

    try:
        yield scope
    except PolicyDenied as denied:
        record(actor, action, "deny", reason=denied.reason, project_id=scope.project_id,
               detail=scope.detail, latency_ms=elapsed())
        raise
    except Exception as error:
        record(actor, action, "error", reason=str(error)[:500], project_id=scope.project_id,
               detail=scope.detail, latency_ms=elapsed())
        raise
    else:
        record(actor, action, "allow", project_id=scope.project_id, detail=scope.detail,
               latency_ms=elapsed())
